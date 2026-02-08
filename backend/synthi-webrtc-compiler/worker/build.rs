use std::env;
use std::path::Path;
use std::process::Command;

fn main() {
    if cfg!(target_os = "linux") {
        println!("cargo:rustc-link-lib=X11");
    }

    println!("cargo:rerun-if-changed=proto");
    println!("cargo:rerun-if-changed=proto/services/emulator-controller/proto/emulator_controller.proto");

    let protoc_from_env = env::var("PROTOC").ok();
    if let Some(ref protoc_path) = protoc_from_env {
        env::set_var("PROTOC", protoc_path);
    }

    let mut protoc_available = protoc_from_env
        .as_deref()
        .map(|p| Path::new(p).exists())
        .unwrap_or(false)
        || Command::new("protoc")
            .arg("--version")
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);

    if !protoc_available {
        match protoc_bin_vendored::protoc_bin_path() {
            Ok(path) => {
                env::set_var("PROTOC", &path);
                protoc_available = true;
            }
            Err(err) => {
                println!("cargo:warning=failed to locate vendored protoc: {}", err);
            }
        }
    }

    if !protoc_available {
        println!("cargo:rustc-cfg=synthi_no_protoc");
        println!("cargo:warning=protoc not found; skipping emulator gRPC codegen");
        return;
    }

    let proto_files = ["proto/services/emulator-controller/proto/emulator_controller.proto"];
    let includes = ["proto/services/emulator-controller/proto", "proto"];

    if let Err(err) = tonic_build::configure()
        .build_server(false)
        .compile(&proto_files, &includes)
    {
        println!("cargo:rustc-cfg=synthi_no_protoc");
        println!(
            "cargo:warning=failed to compile emulator gRPC protos; skipping codegen: {}",
            err
        );
    }
}
