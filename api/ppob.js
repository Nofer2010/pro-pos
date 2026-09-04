import crypto from 'crypto';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed. Gunakan POST.' });
    }

    try {
        const { target, product_code } = req.body;

        if (!target || !product_code) {
            return res.status(400).json({ error: 'Nomor tujuan atau kode produk belum lengkap.' });
        }

        // Mengambil 2 kunci dari Environment Variables Vercel
        const apiId = process.env.VIP_API_ID;       
        const apiKey = process.env.VIP_API_KEY;     

        if (!apiId || !apiKey) {
            return res.status(500).json({ error: 'Konfigurasi API ID atau API Key di Vercel belum lengkap.' });
        }

        // Membuat sign secara otomatis (standar umum: API_ID + API_KEY di-MD5)
        const rawSign = apiId + apiKey;
        const sign = crypto.createHash('md5').update(rawSign).digest('hex');

        // URL endpoint transaksi prepaid VIPayment (sesuaikan jika ada perubahan dari dokumentasi mereka)
        const vipEndpoint = 'https://vipayment.co.id/api/v1/prepaid'; 

        const payload = {
            key: apiKey,
            sign: sign,
            type: 'topup',
            service: product_code,
            target: target
        };

        const apiResponse = await fetch(vipEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const resultData = await apiResponse.json();

        if (resultData.status === true || resultData.success === true) {
            return res.status(200).json({
                status: 'success',
                message: 'Transaksi berhasil diproses!',
                data: resultData.data || resultData
            });
        } else {
            return res.status(400).json({ 
                error: resultData.message || 'Gagal dari server VIPayment.' 
            });
        }

    } catch (error) {
        return res.status(500).json({ error: 'Server error: ' + error.message });
    }
}
