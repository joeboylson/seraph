// Stamps the build time into the binary, so `seraph --version` tells two
// builds of the same version apart, and rebuilds when the page changes.
fn main() {
    let out = std::process::Command::new("date").args(["-u", "+%Y-%m-%d %H:%M UTC"]).output();
    let built = out.ok().and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_default();
    println!("cargo:rustc-env=SERAPH_BUILT={}", built.trim());
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=web/dist");
    println!("cargo:rerun-if-changed=supabase/migrations");
}
