/**


const NOVITA_API_KEY = process.env.NOVITA_API_KEY;
const NOVITA_BASE_URL = process.env.NOVITA_BASE_URL || 'https://api.novita.ai';


function assertEnv() {
if (!NOVITA_API_KEY) {
const err = new Error('NOVITA_API_KEY chýba v env (Render → Environment).');
err.status = 500;
throw err;
}
}


// 💾 Multer – prijmeme 2 obrázky vo forme multipart/form-data
const upload = multer({
limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB podľa Novita limitu
});


/**
* POST /generate
* Prijme jedno z:
* A) JSON: { face_image_file: base64, image_file: base64 }
* B) multipart/form-data s poliami: face_image, image_file
*/
router.post('/generate', upload.fields([
{ name: 'face_image', maxCount: 1 },
{ name: 'image_file', maxCount: 1 },
]), async (req, res) => {
try {
assertEnv();


let faceB64 = null;
let imgB64 = null;


// B) multipart – súbory → base64
const f1 = req.files?.face_image?.[0];
const f2 = req.files?.image_file?.[0];


if (f1 && f2) {
faceB64 = f1.buffer.toString('base64');
imgB64 = f2.buffer.toString('base64');
}


// A) JSON – priame base64 reťazce
if (!faceB64 || !imgB64) {
faceB64 = req.body?.face_image_file || faceB64;
imgB64 = req.body?.image_file || imgB64;
}


if (!faceB64 || !imgB64) {
return res.status(400).json({ error: 'MISSING_IMAGES', detail: 'Pošli face_image + image_file (base64 alebo multipart).' });
}


const payload = {
face_image_file: String(faceB64),
image_file: String(imgB64),
};


const r = await axios.post(
`${NOVITA_BASE_URL}/v3/merge-face`,
payload,
{
headers: {
Authorization: `Bearer ${NOVITA_API_KEY}`,
'Content-Type': 'application/json',
},
timeout: 60000,
}
);


const data = r?.data || {};
const outB64 = data?.image_file || null; // base64 obrázok
const outType = data?.image_type || 'png';


if (!outB64) {
return res.status(502).json({ error: 'NO_IMAGE_DATA', detail: 'API nevrátilo image_file (base64).'});
}


return res.json({ ok: true, image_type: outType, image_base64: outB64, data_url: `data:image/${outType};base64,${outB64}` });
} catch (e) {
const status = e?.status || e?.response?.status || 500;
const details = e?.response?.data || e?.message || 'Unknown error';
console.error('novita-merge-face error:', status, details);
return res.status(status).json({ error: 'SERVER_ERROR', details });
}
});


export default router;
