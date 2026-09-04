const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const crypto = require('crypto');

function getDb() {
    if (!getApps().length) {
        initializeApp({
            credential: cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
            })
        });
    }
    return getFirestore();
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const api_id = req.body.api_id || process.env.VIP_API_ID;
        const api_key = req.body.api_key || process.env.VIP_API_KEY;

        if (!api_id || !api_key) {
            return res.status(400).json({ error: 'API ID dan API Key wajib diisi!' });
        }

        const sign = crypto.createHash('md5').update(api_id + api_key).digest('hex');

        // 1. Request Daftar Produk
        let response;
        try {
            const bodyParams = new URLSearchParams();
            bodyParams.append('key', api_key);
            bodyParams.append('sign', sign);
            bodyParams.append('type', 'services');

            response = await fetch('https://vipayment.co.id/api/prepaid', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0'
                },
                body: bodyParams.toString()
            });
        } catch (fetchErr) {
            return res.status(500).json({ error: 'Gagal koneksi fetch ke VIPayment (Prepaid): ' + fetchErr.message });
        }

        const textResponse = await response.text();
        let data;
        try {
            data = JSON.parse(textResponse);
        } catch (err) {
            return res.status(400).json({ error: 'VIPayment merespon bukan JSON: ' + textResponse.substring(0, 100) });
        }

        if (!data || data.result !== true || !data.data) {
            return res.status(400).json({ 
                error: 'Gagal dari VIPayment: ' + (data && (data.message || data.note) ? (data.message || data.note) : 'Respon tidak valid') 
            });
        }

        // 2. Request Profil / Saldo Akun
        let saldoPusat = 0;
        try {
            const profileParams = new URLSearchParams();
            profileParams.append('key', api_key);
            profileParams.append('sign', sign);

            const resProfile = await fetch('https://vipayment.co.id/api/profile', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0'
                },
                body: profileParams.toString()
            });
            const profileText = await resProfile.text();
            const profileData = JSON.parse(profileText);
            saldoPusat = profileData && profileData.data ? (profileData.data.balance || 0) : 0;
        } catch (e) {
            // Jika profil gagal, lanjut saja dengan saldo 0
        }

        // 3. Simpan ke Firebase Firestore
        const db = getDb();
        const batch = db.batch();
        let totalDisinkronkan = 0;

        const settingRef = db.collection('pengaturan_sistem').doc('vipayment');
        batch.set(settingRef, { 
            saldo_vipayment: saldoPusat, 
            waktu_update: new Date() 
        }, { merge: true });

        data.data.forEach(item => {
            if (item.status === 'available') {
                const produkRef = db.collection('produk_ppob').doc(String(item.code));
                batch.set(produkRef, {
                    kode: item.code,
                    nama: item.name,
                    kategori: item.brand,
                    harga_modal: parseInt(item.price) || 0,
                    status: item.status,
                    waktu_sync: new Date()
                }, { merge: true });
                totalDisinkronkan++;
            }
        });

        await batch.commit();

        return res.status(200).json({ 
            status: 'success', 
            message: `Berhasil menyinkronkan ${totalDisinkronkan} produk PPOB!`,
            saldo: saldoPusat 
        });

    } catch (e) {
        console.error("Sync Error Detail:", e);
        return res.status(500).json({ error: 'Internal Server Error: ' + e.message });
    }
};
