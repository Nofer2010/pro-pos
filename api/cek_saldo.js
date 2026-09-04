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
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const db = getDb();
        // Membaca kredensial API ID & API Key yang tersimpan permanen di Firestore
        const settingDoc = await db.collection('pengaturan_sistem').doc('vipayment').get();
        
        if (!settingDoc.exists) {
            return res.status(400).json({ error: 'Kredensial belum tersimpan. Lakukan sinkronisasi produk sekali terlebih dahulu.' });
        }

        const config = settingDoc.data();
        const api_id = config.api_id;
        const api_key = config.api_key;

        if (!api_id || !api_key) {
            return res.status(400).json({ error: 'API ID atau API Key tidak lengkap di database.' });
        }

        // Membuat MD5 signature resmi sesuai dokumentasi VIP-Reseller
        const sign = crypto.createHash('md5').update(api_id + api_key).digest('hex');

        const profileParams = new URLSearchParams();
        profileParams.append('key', api_key);
        profileParams.append('sign', sign);

        // Menembak langsung ke API profil VIP-Reseller
        const resProfile = await axios.post('https://vip-reseller.co.id/api/profile', profileParams, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const profileData = resProfile.data;
        const saldoPusat = profileData && profileData.data ? (profileData.data.balance || 0) : 0;

        // Simpan pembaruan saldo ke Firestore
        await db.collection('pengaturan_sistem').doc('vipayment').set({
            saldo_vipayment: saldoPusat,
            waktu_update: new Date()
        }, { merge: true });

        return res.status(200).json({
            status: 'success',
            saldo: saldoPusat
        });

    } catch (e) {
        console.error("Cek Saldo Error:", e);
        return res.status(500).json({ error: 'Gagal mengambil saldo: ' + (e.response?.data?.message || e.message) });
    }
};
