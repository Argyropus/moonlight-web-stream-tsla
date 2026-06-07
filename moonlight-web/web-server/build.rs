fn main() {
    // Embed Windows application icon and version info.
    // Use target_os (not host OS) so this works when cross-compiling from Linux via `cross`.
    #[cfg(target_os = "windows")]
    embed_windows_resources();

    // Also handle cross-compilation: if we're on a non-Windows host but targeting Windows,
    // cfg(target_os) won't work in build.rs (it reflects the HOST). Use env var instead.
    #[cfg(not(target_os = "windows"))]
    {
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
            embed_windows_resources();
        }
    }
}

fn embed_windows_resources() {
    let mut res = winresource::WindowsResource::new();
    res.set_icon("assets/app.ico");
    res.set("ProductName", "Moonlight Web Tesla");
    res.set("FileDescription", "Moonlight Web Stream Server for Tesla");
    res.set("LegalCopyright", "GPL-3.0-or-later");
    res.compile().expect("failed to compile Windows resources");
}
