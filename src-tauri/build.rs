fn main() {
    println!("cargo:rerun-if-env-changed=STUDIO_REPORT_ENDPOINT");
    println!("cargo:rerun-if-env-changed=STUDIO_QA_TLS_CERT_PEM");
    // El manifiesto de Windows (Common Controls v6, necesario para los diálogos) se incrusta en
    // todos los binarios, incluidos los de prueba: si solo lo tuvieran los ejecutables,
    // `cargo test` fallaría con STATUS_ENTRYPOINT_NOT_FOUND.
    let attrs = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attrs).expect("tauri-build");
    // tauri-build no vuelve a compilar el recurso de Windows si solo cambia el icono.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=windows-app.manifest");
        embed_resource::compile_for_everything("windows-manifest.rc", embed_resource::NONE)
            .manifest_required()
            .expect("manifiesto de Windows");
    }
}
