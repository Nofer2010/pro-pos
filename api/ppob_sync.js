const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const crypto = require('crypto');

// Inisialisasi Firebase Admin menggunakan variabel terpisah di Vercel Abang
if (!getApps().length) {
    initializeApp({
        credential: cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        })
    });
}
const db = getFirestore();

module.exports = async (req, res) => {
    // Pastikan method request adalah POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const api_id = req.body.api_id || process.env.VIP_API_ID;
    const api_key = req.body.api_key || process.env.VIP_API_KEY;
    if (!api_id || !api_key) {
        return res.status(400).json({ error: 'API ID dan API Key wajib diisi!' });
    }

    try {
        // 1. Enkripsi Signature MD5 sesuai standar dokumentasi VIPayment
        const sign = crypto.createHash('md5').update(api_id + api_key).digest('hex');

        // 2. Request Daftar Produk (Prepaid Services) dari API VIPayment
        const response = await fetch('https://vipayment.co.id/api/prepaid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                key: api_key,
                sign: sign,
                type: 'services'
            })
        });

        const data = await response.json();

        // Pengecekan respons yang aman dan akurat
        if (!data || data.result !== true || !data.data) {
            return res.status(400).json({ 
                error: 'Gagal mengambil data dari VIPayment: ' + (data && (data.message || data.note) ? (data.message || data.note) : 'Respon tidak valid atau kosong') 
            });
        }

        // 3. Request Profil / Saldo Akun VIPayment secara real-time
        const resProfile = await fetch('https://vipayment.co.id/api/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ key: api_key, sign: sign })
        });
        const profileData = await resProfile.json();
        const saldoPusat = profileData && profileData.data ? (profileData.data.balance || 0) : 0;

        // 4. Simpan Saldo Pusat & Produk ke Firebase Firestore secara Batch
        const batch = db.batch();
        let totalDisinkronkan = 0;

        // Simpan saldo pusat ke dokumen pengaturan sistem
        const settingRef = db.collection('pengaturan_sistem').doc('vipayment');
        batch.set(settingRef, { 
            saldo_vipayment: saldoPusat, 
            waktu_update: new Date() 
        }, { merge: true });

        // Looping data produk dan masukkan ke koleksi 'produk_ppob'
        data.data.forEach(item => {
            if (item.status === 'available') { // Hanya simpan produk yang berstatus aktif
                const produkRef = db.collection('produk_ppob').doc(item.code);
                batch.set(produkRef, {
                    kode: item.code,
                    nama: item.name,
                    kategori: item.brand,
                    harga_modal: parseInt(item.price),
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
        return res.status(500).json({ error: e.message });
    }
};
