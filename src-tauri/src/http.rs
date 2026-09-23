//! Response bodies with gzip handled by us instead of ureq, so the engine can
//! tell how many bytes actually crossed the network (compressed) and how many
//! it had to parse (decompressed).

use std::io::Read;

/// Sent on Dataverse Web API requests; the bodies are then decoded here.
pub const ACCEPT_ENCODING: &str = "gzip";

/// Counts the bytes read through it.
pub struct Counting<R> {
    pub inner: R,
    pub n: usize,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.n += n;
        Ok(n)
    }
}

fn is_gzip(resp: &ureq::Response) -> bool {
    resp.header("Content-Encoding")
        .map(|v| v.trim().eq_ignore_ascii_case("gzip") || v.trim().eq_ignore_ascii_case("x-gzip"))
        .unwrap_or(false)
}

/// Bytes as they came off the wire and after decompression.
#[derive(Clone, Copy, Default, Debug)]
pub struct Sizes {
    pub wire: usize,
    pub decoded: usize,
}

/// Hand the (decompressed, buffered) body to `f` and report both sizes.
pub fn read_body<T>(
    resp: ureq::Response,
    f: impl FnOnce(&mut dyn Read) -> std::io::Result<T>,
) -> std::io::Result<(T, Sizes)> {
    let gz = is_gzip(&resp);
    let mut wire = Counting { inner: resp.into_reader(), n: 0 };
    let (value, decoded) = if gz {
        let mut dec = Counting { inner: flate2::read::GzDecoder::new(&mut wire), n: 0 };
        let v = f(&mut std::io::BufReader::with_capacity(64 * 1024, &mut dec))?;
        (v, dec.n)
    } else {
        let mut plain = Counting { inner: &mut wire, n: 0 };
        let v = f(&mut std::io::BufReader::with_capacity(64 * 1024, &mut plain))?;
        (v, plain.n)
    };
    Ok((value, Sizes { wire: wire.n, decoded }))
}

/// Parse a JSON body, decompressing it if the server gzipped it.
pub fn json_sized<T: serde::de::DeserializeOwned>(resp: ureq::Response) -> std::io::Result<(T, Sizes)> {
    read_body(resp, |r| serde_json::from_reader(r).map_err(std::io::Error::from))
}

pub fn json<T: serde::de::DeserializeOwned>(resp: ureq::Response) -> std::io::Result<T> {
    json_sized(resp).map(|(v, _)| v)
}

/// A body as text (error messages), decompressing it if needed.
pub fn text(resp: ureq::Response) -> String {
    let gz = is_gzip(&resp);
    let mut out = String::new();
    let reader = resp.into_reader().take(10 * 1024 * 1024);
    let _ = if gz {
        flate2::read::GzDecoder::new(reader).read_to_string(&mut out)
    } else {
        let mut r = reader;
        r.read_to_string(&mut out)
    };
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn serve(body: Vec<u8>, gzip: bool) -> String {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", server.server_addr());
        std::thread::spawn(move || {
            if let Ok(req) = server.recv() {
                let mut resp = tiny_http::Response::from_data(body);
                if gzip {
                    resp = resp.with_header(tiny_http::Header::from_bytes("Content-Encoding", "gzip").unwrap());
                }
                let _ = req.respond(resp);
            }
        });
        url
    }

    #[test]
    fn gzip_bodies_are_decoded_and_both_sizes_counted() {
        let json = format!(r#"{{"value":"{}"}}"#, "a".repeat(10_000));
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(json.as_bytes()).unwrap();
        let url = serve(enc.finish().unwrap(), true);
        let resp = ureq::get(&url).set("Accept-Encoding", ACCEPT_ENCODING).call().unwrap();
        let (v, sizes): (serde_json::Value, Sizes) = json_sized(resp).unwrap();
        assert_eq!(v["value"].as_str().unwrap().len(), 10_000);
        assert_eq!(sizes.decoded, json.len());
        assert!(sizes.wire < 1_000, "compressed size {}", sizes.wire);
    }

    #[test]
    fn plain_bodies_pass_through() {
        let url = serve(br#"{"a":1}"#.to_vec(), false);
        let (v, sizes): (serde_json::Value, Sizes) = json_sized(ureq::get(&url).call().unwrap()).unwrap();
        assert_eq!(v["a"], 1);
        assert_eq!((sizes.wire, sizes.decoded), (7, 7));
    }
}
