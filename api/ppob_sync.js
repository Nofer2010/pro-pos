const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const crypto = require('crypto');
const axios = require('axios');

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

        const bodyParams = new URLSearchParams();
        bodyParams.append('key', api_key);
        bodyParams.append('sign', sign);
        bodyParams.append('type', 'services');

        const response = await axios.post('https://vipayment.co.id/api/prepaid', bodyParams, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        const data = response.data;

        if (!data || data.result !== true || !data.data) {
            return res.status(400).json({ error: 'Gagal dari VIPayment: ' + (data?.message || data?.note || 'Respon tidak valid') });
        }

        const profileParams = new URLSearchParams();
        profileParams.append('key', api_key);
        profileParams.append('sign', sign);

        let saldoPusat = 0;
        try {
            const resProfile = await axios.post('https://vipayment.co.id/api/profile', profileParams, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            saldoPusat = resProfile.data?.data?.balance || 0;
        } catch (e) {}

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
        console.error("Sync Error:", e);
        return res.status(500).json({ error: 'Internal Server Error: ' + (e.response?.data?.message || e.message) });
    }
};
