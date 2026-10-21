//! Encrypting a push's message for one phone (RFC 8291, "aes128gcm"), so a
//! notification can say which session and why while the push service in
//! between sees only ciphertext.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use anyhow::{anyhow, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use rand_core::{OsRng, RngCore};
use sha2::Sha256;

/// The record size written in the header; one record holds the whole message.
const RECORD_SIZE: u32 = 4096;

fn hkdf(salt: &[u8], ikm: &[u8], info: &[u8], len: usize) -> Result<Vec<u8>> {
    let mut out = vec![0u8; len];
    Hkdf::<Sha256>::new(Some(salt), ikm).expand(info, &mut out).map_err(|_| anyhow!("hkdf length"))?;
    Ok(out)
}

/// The body of an encrypted push for the phone whose subscription keys are
/// `p256dh` (its public key) and `auth`, both base64url as browsers give them.
pub fn encrypt(message: &[u8], p256dh: &str, auth: &str) -> Result<Vec<u8>> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    encrypt_with(message, p256dh, auth, &SecretKey::random(&mut OsRng), &salt)
}

/// `encrypt` with a given one-time key and salt (fixed ones, in tests).
fn encrypt_with(message: &[u8], p256dh: &str, auth: &str, as_secret: &SecretKey, salt: &[u8; 16]) -> Result<Vec<u8>> {
    let ua_public_bytes = URL_SAFE_NO_PAD.decode(p256dh.trim_end_matches('='))?;
    let auth = URL_SAFE_NO_PAD.decode(auth.trim_end_matches('='))?;
    let ua_public = PublicKey::from_sec1_bytes(&ua_public_bytes).map_err(|_| anyhow!("bad p256dh key"))?;

    let as_public = as_secret.public_key().to_encoded_point(false);
    let shared = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua_public.as_affine());

    // The key the phone can also work out, from its secret and the auth secret.
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(&ua_public_bytes);
    key_info.extend_from_slice(as_public.as_bytes());
    let ikm = hkdf(&auth, shared.raw_secret_bytes(), &key_info, 32)?;

    let cek = hkdf(salt, &ikm, b"Content-Encoding: aes128gcm\0", 16)?;
    let nonce = hkdf(salt, &ikm, b"Content-Encoding: nonce\0", 12)?;

    // One record: the message, then 0x02 to mark it as the last.
    let mut plain = message.to_vec();
    plain.push(2);
    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|_| anyhow!("key length"))?;
    let nonce: [u8; 12] = nonce.try_into().map_err(|_| anyhow!("nonce length"))?;
    let sealed = cipher.encrypt(&Nonce::from(nonce), plain.as_slice()).map_err(|_| anyhow!("encrypt"))?;

    let mut body = salt.to_vec();
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.as_bytes().len() as u8);
    body.extend_from_slice(as_public.as_bytes());
    body.extend_from_slice(&sealed);
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_worked_example_in_rfc_8291() {
        let b64 = |s: &str| URL_SAFE_NO_PAD.decode(s).unwrap();
        let as_secret = SecretKey::from_slice(&b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let salt: [u8; 16] = b64("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let body = encrypt_with(
            b"When I grow up, I want to be a watermelon",
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
            "BTBZMqHH6r4Tts7J_aSIgg",
            &as_secret,
            &salt,
        )
        .unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }

    /// What a phone does on receiving it: decrypt with its own secret.
    fn decrypt(body: &[u8], ua_secret: &SecretKey, auth: &[u8]) -> Vec<u8> {
        let (salt, rest) = body.split_at(16);
        let id_len = rest[4] as usize;
        let as_public_bytes = &rest[5..5 + id_len];
        let sealed = &rest[5 + id_len..];
        let as_public = PublicKey::from_sec1_bytes(as_public_bytes).unwrap();
        let shared = p256::ecdh::diffie_hellman(ua_secret.to_nonzero_scalar(), as_public.as_affine());
        let ua_public = ua_secret.public_key().to_encoded_point(false);
        let mut key_info = b"WebPush: info\0".to_vec();
        key_info.extend_from_slice(ua_public.as_bytes());
        key_info.extend_from_slice(as_public_bytes);
        let ikm = hkdf(auth, shared.raw_secret_bytes(), &key_info, 32).unwrap();
        let cek = hkdf(salt, &ikm, b"Content-Encoding: aes128gcm\0", 16).unwrap();
        let nonce = hkdf(salt, &ikm, b"Content-Encoding: nonce\0", 12).unwrap();
        let nonce: [u8; 12] = nonce.try_into().unwrap();
        let mut plain = Aes128Gcm::new_from_slice(&cek).unwrap().decrypt(&Nonce::from(nonce), sealed).unwrap();
        assert_eq!(plain.pop(), Some(2));
        plain
    }

    #[test]
    fn a_phone_can_read_what_it_was_sent() {
        let ua_secret = SecretKey::random(&mut OsRng);
        let p256dh = URL_SAFE_NO_PAD.encode(ua_secret.public_key().to_encoded_point(false).as_bytes());
        let mut auth = [0u8; 16];
        OsRng.fill_bytes(&mut auth);
        let message = br#"{"title":"landing page needs you"}"#;
        let body = encrypt(message, &p256dh, &URL_SAFE_NO_PAD.encode(auth)).unwrap();
        assert_eq!(decrypt(&body, &ua_secret, &auth), message);
        // Each push is sealed afresh: the same message never looks the same twice.
        assert_ne!(body, encrypt(message, &p256dh, &URL_SAFE_NO_PAD.encode(auth)).unwrap());
    }
}
