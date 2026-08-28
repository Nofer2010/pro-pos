import admin from 'firebase-admin';
import crypto from 'crypto';
import Midtrans from 'midtrans-client'; 

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
        // HAPUS 'amount' dari destructuring, kita wajib hitung dari server
        const { bos_id, items, order_id, paymentMethod } = req.body; 

        if (!bos_id || !items || items.length === 0) {
            return res.status(400).json({ error: 'Data transaksi tidak lengkap.' });
        }

        const userDocRef = db.collection("users").doc(bos_id);
        const userSnap = await userDocRef.get();

        if (!userSnap.exists) {
            return res.status(404).json({ error: 'Data toko/owner tidak ditemukan di database.' });
        }

        // ==========================================
        // 🔒 KALKULASI HARGA AMAN DI BACKEND
        // ==========================================
        let calculatedAmount = 0;
        let secureItems = [];

        // Loop untuk mengecek harga asli dari Firestore
        for (let item of items) {
            const brgRef = db.collection("barang").doc(item.id);
            const brgSnap = await brgRef.get();
            
            if (brgSnap.exists) {
                const dataBarang = brgSnap.data();
                
                // Hitung harga asli setelah diskon (jika ada)
                const persenDiskon = dataBarang.diskon || 0;
                const hargaSetelahDiskon = dataBarang.jual - (dataBarang.jual * persenDiskon / 100);
                
                calculatedAmount += (hargaSetelahDiskon * item.qty);
                
                secureItems.push({
                    nama: dataBarang.nama,
                    qty: item.qty,
                    price: hargaSetelahDiskon // Format untuk iPaymu
                });
            } else {
                return res.status(404).json({ error: `Ada barang yang tidak valid/dihapus dari database.` });
            }
        }

        // KUNCI: Gunakan calculatedAmount sebagai amount resmi tagihan
        const amount = calculatedAmount;

        const userData = userSnap.data();
        // Fallback metode pembayaran jika tidak dikirim spesifik
        const activeGateway = paymentMethod || userData.gateway_pilihan || userData.active_gateway || 'ipaymu'; 

        // ==========================================
        // OPSI A: JIKA KLIEN MENGGUNAKAN IPAYMU
        // ==========================================
        if (activeGateway === 'ipaymu' || activeGateway === 'va') {
            const ipaymuApiKey = userData.ipaymu_apikey || userData.ipaymu_api_key;
            const ipaymuVa = userData.ipaymu_va;

            if (!ipaymuApiKey || !ipaymuVa) {
                return res.status(400).json({ error: 'Owner toko belum mengatur API Key & VA iPaymu.' });
            }

            const ipaymuUrl = 'https://ipaymu.com/api/v2/payment'; 

            const bodyRequest = {
                // GUNAKAN secureItems AGAR INVOICE IPAYMU AKURAT
                product: secureItems.map(i => i.nama),
                qty: secureItems.map(i => i.qty),
                price: secureItems.map(i => i.price),
                amount: amount,
                returnUrl: 'https://pro-pos.vercel.app/success',
                cancelUrl: 'https://pro-pos.vercel.app/cancel',
                referenceId: order_id || 'TRX-' + Date.now(),
                notifyUrl: 'https://pro-pos.vercel.app/api/webhook'
            };

            const jsonBody = JSON.stringify(bodyRequest);
            const hashBody = crypto.createHash('sha256').update(jsonBody).digest('hex');
            const stringToSign = `POST:${ipaymuVa}:${hashBody}:${ipaymuApiKey}`;
            const signature = crypto.createHmac('sha256', ipaymuApiKey).update(stringToSign).digest('hex');

            const ipaymuResponse = await fetch(ipaymuUrl, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'va': ipaymuVa,
                    'signature': signature
                },
                body: jsonBody
            });

            const responseData = await ipaymuResponse.json();

            if (responseData.success) {
                return res.status(200).json({
                    status: 'success',
                    paymentUrl: responseData.Data.url, 
                    qrString: responseData.Data.qrString || null,
                    vaNumber: responseData.Data.account || responseData.Data.va || null
                });
            } else {
                return res.status(400).json({ error: responseData.message || 'Gagal memproses iPaymu.' });
            }
        }

        // ==========================================
        // OPSI B: JIKA KLIEN MENGGUNAKAN MIDTRANS
        // ==========================================
        else if (activeGateway === 'midtrans' || activeGateway === 'qris') {
            const serverKey = userData.midtrans_serverkey || userData.midtrans_server_key;
            const clientKey = userData.midtrans_clientkey || userData.midtrans_client_key;

            if (!serverKey) {
                return res.status(400).json({ error: 'Owner toko belum mengatur Server Key Midtrans.' });
            }

            let snap = new Midtrans.Snap({
                isProduction: true, 
                serverKey: serverKey,
                clientKey: clientKey || ''
            });

            let parameter = {
                transaction_details: {
                    order_id: order_id || 'TRX-MID-' + Date.now(),
                    gross_amount: parseInt(amount)
                }
            };

            const transaction = await snap.createTransaction(parameter);
            return res.status(200).json({
                status: 'success',
                token: transaction.token,
                clientKey: clientKey
            });
        }

        // ==========================================
        // OPSI C: JIKA KLIEN MENGGUNAKAN XENDIT
        // ==========================================
        else if (activeGateway === 'xendit') {
            const xenditApiKey = userData.xendit_key || userData.xendit_api_key;

            if (!xenditApiKey) {
                return res.status(400).json({ error: 'Owner toko belum mengatur API Key Xendit.' });
            }

            const xenditResponse = await fetch('https://api.xendit.co/v2/invoices', {
                method: 'POST',
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(xenditApiKey + ':').toString('base64'),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    external_id: order_id || 'TRX-XND-' + Date.now(),
                    amount: parseInt(amount),
                    description: 'Pembayaran Pesanan'
                })
            });

            const xenditData = await xenditResponse.json();

            if (xenditResponse.ok) {
                return res.status(200).json({
                    status: 'success',
                    paymentUrl: xenditData.invoice_url 
                });
            } else {
                return res.status(400).json({ error: xenditData.message || 'Gagal memproses Xendit.' });
            }
        }

        else {
            return res.status(400).json({ error: 'Gateway pembayaran tidak valid atau belum dipilih.' });
        }

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
