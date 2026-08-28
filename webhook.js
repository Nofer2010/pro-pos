import admin from 'firebase-admin';

// Inisialisasi Firebase Admin pakai Environment Variables Vercel
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        })
    });
}

const db = admin.firestore();

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const notification = req.body;
        
        let orderId = null;
        let transactionStatus = null;
        let gatewayType = null;

        // 1. Deteksi Midtrans Notification
        if (notification.transaction_status && notification.order_id) {
            gatewayType = 'midtrans';
            orderId = notification.order_id;
            const status = notification.transaction_status;
            if (status === 'capture' || status === 'settlement') {
                transactionStatus = 'SUCCESS';
            } else if (status === 'cancel' || status === 'expire' || status === 'deny') {
                transactionStatus = 'FAILED';
            }
        } 
        // 2. Deteksi iPaymu Notification
        else if (notification.trx_id && notification.reference_id) {
            gatewayType = 'ipaymu';
            orderId = notification.reference_id;
            if (notification.status_code == 1 || notification.status === 'berhasil' || notification.status === 'sukses') { 
                transactionStatus = 'SUCCESS';
            } else {
                transactionStatus = 'FAILED';
            }
        }
        // 3. Deteksi Xendit Notification
        else if (notification.external_id && notification.status) {
            gatewayType = 'xendit';
            orderId = notification.external_id;
            if (notification.status === 'PAID' || notification.status === 'COMPLETED') {
                transactionStatus = 'SUCCESS';
            } else {
                transactionStatus = 'EXPIRED';
            }
        }

        if (!orderId) {
            return res.status(400).json({ error: 'Format webhook tidak dikenali.' });
        }

        if (transactionStatus === 'SUCCESS') {
            console.log(`Webhook ${gatewayType} diterima untuk Order ID: ${orderId} - Status: BERHASIL`);
            try {
                const paymentRef = db.collection("pending_payments").doc(orderId);
                const paymentSnap = await paymentRef.get();

                if (paymentSnap.exists) {
                    const paymentData = paymentSnap.data();

                    // 1. Update status pembayaran di database menjadi LUNAS
                    await paymentRef.update({ 
                        status: "SUCCESS",
                        waktu_lunas: admin.firestore.FieldValue.serverTimestamp()
                    });
                    console.log(`Firebase Order ${orderId} berhasil diupdate ke SUCCESS.`);

                    // ==========================================================
                    // 2. LOGIKA OTOMATISASI MASA AKTIF SAAS (PERPANJANGAN)
                    // ==========================================================
                    // Deteksi jika ini adalah pembayaran langganan SaaS (Bukan kasir)
                    if (orderId.startsWith('SAAS') || paymentData.jenis_transaksi === 'SAAS') {
                        const bosId = paymentData.bos_id;
                        const userRef = db.collection("users").doc(bosId);
                        const userSnap = await userRef.get();

                        if (userSnap.exists) {
                            const userData = userSnap.data();
                            const now = new Date();
                            
                            let currentDate = now;
                            // Jika masa aktif saat ini belum expired, tambahkan dari sisa harinya
                            if (userData.batas_waktu) {
                                const batasLama = new Date(userData.batas_waktu);
                                if (batasLama > now) {
                                    currentDate = batasLama;
                                }
                            }

                            let newBatasWaktu = new Date(currentDate);
                            let tipeLisensiBaru = "sewa";
                            
                            // Ambil data paket bulan (default 1 jika kosong)
                            const paket = paymentData.paket_bulan || 1; 

                            if (paket === 'permanen' || paket === 999) {
                                tipeLisensiBaru = "permanen";
                                newBatasWaktu = null; // Permanen tidak butuh batas waktu
                            } else {
                                // Konversi bulan ke hari
                                let tambahanHari = parseInt(paket) * 30;
                                if (paket == 3) tambahanHari = 90;
                                else if (paket == 6) tambahanHari = 180;
                                else if (paket == 12) tambahanHari = 365;

                                newBatasWaktu.setDate(newBatasWaktu.getDate() + tambahanHari);
                                newBatasWaktu.setHours(23, 59, 59, 999); // Set ke jam 23:59:59 akhir hari
                            }

                            // Update data Toko/Klien dengan masa aktif yang baru
                            await userRef.update({
                                tipe_lisensi: tipeLisensiBaru,
                                batas_waktu: newBatasWaktu ? newBatasWaktu.toISOString() : null,
                                nominal_bayar: paymentData.total || 0
                            });

                            // Rekam juga ke tabel 'saas_payments' agar otomatis masuk ke 
                            // laporan statistik pendapatan di dashboard Super Admin
                            await db.collection("saas_payments").add({
                                klien_id: bosId,
                                namaToko: userData.namaToko || "Toko Klien",
                                tipe_lisensi: tipeLisensiBaru,
                                paket_bulan: paket,
                                nominal: paymentData.total || 0,
                                waktu: admin.firestore.FieldValue.serverTimestamp()
                            });

                            console.log(`SaaS untuk ${bosId} diperpanjang otomatis. Paket: ${paket} bulan.`);
                        }
                    }
                } else {
                    console.log(`Order ID ${orderId} tidak ditemukan di pending_payments.`);
                }
            } catch (err) {
                console.error("Gagal update status Firebase:", err);
                return res.status(500).json({ error: 'Gagal memperbarui status database.' });
            }
        } else {
            console.log(`Webhook ${gatewayType} diterima untuk Order ID: ${orderId} - Status: ${transactionStatus}`);
        }

        return res.status(200).json({ status: 'OK', message: 'Webhook berhasil diproses' });

    } catch (error) {
        console.error("Error Webhook:", error);
        return res.status(500).json({ error: error.message });
    }
}
