use anyhow::{bail, Context, Result};
use bindgen::callbacks::{AttributeInfo, DeriveInfo, ParseCallbacks};
use std::{
    env,
    fs::File,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    process::Command,
};

/// Name and minimum version of the library that we are binding to.
const LIB_NAME: &str = "webrtc-audio-processing-2";
#[cfg(not(feature = "bundled"))]
const LIB_MIN_VERSION: &str = "2.1";

const MACOSX_DEPLOYMENT_TARGET_VAR: &str = "MACOSX_DEPLOYMENT_TARGET";

/// Symbol prefix for the webrtc-audio-processing library to allow multiple versions to coexist.
const SYMBOL_PREFIX: &str = "v2_";

fn out_dir() -> PathBuf {
    std::env::var("OUT_DIR").expect("OUT_DIR environment var not set.").into()
}

/// Prefix specified symbols in an object or static library using objcopy --redefine-sym.
fn prefix_archive_symbols(archive_path: &Path, symbols: &[String], prefix: &str) -> Result<()> {
    if symbols.is_empty() {
        return Ok(());
    }

    eprintln!(
        "Prefixing {} symbols in {} with '{}'",
        symbols.len(),
        archive_path.display(),
        prefix
    );

    let temp_path = archive_path.with_extension("prefixed");

    let objcopy = determine_objcopy_path()?;

    // Write arguments to a temp file to avoid "Argument list too long" errors.
    let args_path = archive_path.with_extension("args");
    let mut writer = BufWriter::new(File::create(&args_path)?);
    for symbol in symbols {
        writeln!(writer, "--redefine-sym={}={}{}", symbol, prefix, symbol)?;
    }
    writer.flush()?;
    drop(writer);

    let mut cmd = Command::new(&objcopy);
    cmd.arg(format!("@{}", args_path.display()));
    cmd.arg(archive_path);
    cmd.arg(&temp_path);

    eprintln!("Running {cmd:?}");
    let status = cmd.status().context(format!("Failed to execute {:?}", objcopy))?;

    if !status.success() {
        anyhow::bail!("{:?} failed with status: {}", objcopy, status);
    }

    std::fs::rename(&temp_path, archive_path).with_context(|| {
        format!("Failed to rename {} to {}", temp_path.display(), archive_path.display())
    })?;

    Ok(())
}

#[cfg(not(feature = "bundled"))]
mod webrtc {
    use super::*;
    use anyhow::{bail, Result};

    pub(super) fn get_build_paths() -> Result<(Vec<PathBuf>, Vec<PathBuf>)> {
        let (pkgconfig_include_path, pkgconfig_lib_path) = find_pkgconfig_paths()?;

        let include_path = std::env::var("WEBRTC_AUDIO_PROCESSING_INCLUDE")
            .ok()
            .map(PathBuf::from)
            .or(pkgconfig_include_path);
        let lib_path = std::env::var("WEBRTC_AUDIO_PROCESSING_LIB")
            .ok()
            .map(PathBuf::from)
            .or(pkgconfig_lib_path);

        if include_path.is_none() || lib_path.is_none() {
            bail!(
                "Couldn't find {}. Please install it or set WEBRTC_AUDIO_PROCESSING_INCLUDE and WEBRTC_AUDIO_PROCESSING_LIB environment variables.",
                LIB_NAME
            );
        }

        Ok((vec![include_path.unwrap()], vec![lib_path.unwrap()]))
    }

    pub(super) fn build_if_necessary() -> Result<()> {
        Ok(())
    }

    fn find_pkgconfig_paths() -> Result<(Option<PathBuf>, Option<PathBuf>)> {
        let lib = match pkg_config::Config::new()
            .atleast_version(LIB_MIN_VERSION)
            .statik(false)
            .probe(LIB_NAME)
        {
            Ok(lib) => lib,
            Err(e) => {
                eprintln!("Couldn't find {LIB_NAME} with pkg-config:");
                eprintln!("{e}");
                return Ok((None, None));
            }
        };

        Ok((lib.include_paths.first().cloned(), lib.link_paths.first().cloned()))
    }

    pub(super) fn prefix_library_symbols(
        _lib_dirs: &[PathBuf],
        _prefix: &str,
    ) -> Result<Vec<String>> {
        println!(
            "cargo:warning=Symbol prefixing is only supported with the 'bundled' feature. \
            Without it, linking multiple versions of this crate may cause symbol conflicts."
        );

        Ok(vec![])
    }
}

#[cfg(feature = "bundled")]
mod webrtc {
    use super::*;
    use anyhow::{bail, Context};
    use std::{
        collections::HashSet,
        fs,
        io::{BufRead, BufReader},
        process::Command,
    };

    const BUNDLED_SOURCE_PATH: &str = "webrtc-audio-processing";
    const BUNDLED_SOURCE_COPY_PATH: &str = "src";
    const BUNDLED_BUILD_PATH: &str = "build";

    pub(super) fn get_build_paths() -> Result<(Vec<PathBuf>, Vec<PathBuf>)> {
        let bundled_source_dir = bundled_source_dir();
        let mut include_paths = vec![
            out_dir().join("include"),
            out_dir().join("include").join(LIB_NAME),
            bundled_source_dir.clone(),
            bundled_source_dir.join("webrtc"),
        ];
        let mut lib_paths = vec![
            out_dir().join("lib"),
            out_dir().join("lib").join("x86_64-linux-gnu"),
            out_dir().join("lib64"),
        ];

        if let Ok(mut lib) =
            pkg_config::Config::new().atleast_version("20240722").probe("absl_base")
        {
            include_paths.append(&mut lib.include_paths);
            lib_paths.append(&mut lib.link_paths);
        } else {
            include_paths.push(
                bundled_source_dir
                    .join("subprojects")
                    .join("abseil-cpp-20240722.0"),
            );
            lib_paths.push(
                bundled_work_dir()
                    .join(BUNDLED_BUILD_PATH)
                    .join("subprojects")
                    .join("abseil-cpp-20240722.0"),
            );
        }

        Ok((include_paths, lib_paths))
    }

    pub(super) fn build_if_necessary() -> Result<()> {
        let vendor_source_dir = src_dir().join(BUNDLED_SOURCE_PATH);
        if vendor_source_dir.read_dir()?.next().is_none() {
            eprintln!("The webrtc-audio-processing source directory is empty.");
            eprintln!("See the crate README for installation instructions.");
            eprintln!("Remember to clone the repo recursively if building from source.");
            bail!("Aborting compilation because bundled source directory is empty.");
        }

        let build_dir = bundled_work_dir().join(BUNDLED_BUILD_PATH);
        let install_dir = out_dir();
        let source_dir = bundled_source_dir();

        if source_dir.exists() {
            fs::remove_dir_all(&source_dir)
                .with_context(|| format!("Failed to remove {}", source_dir.display()))?;
        }
        copy_dir_recursively(&vendor_source_dir, &source_dir)?;

        if build_dir.exists() {
            fs::remove_dir_all(&build_dir)
                .with_context(|| format!("Failed to remove {}", build_dir.display()))?;
        }

        fs::create_dir_all(&build_dir)?;
        eprintln!("Building webrtc-audio-processing in {}", build_dir.display());

        let mut meson = Command::new("meson");
        meson.args(["setup", "--prefix", install_dir.to_str().unwrap()]);

        if cfg!(target_os = "macos") {
            let link_args = "['-framework', 'CoreFoundation', '-framework', 'Foundation']";
            meson.arg(format!("-Dc_link_args={}", link_args));
            meson.arg(format!("-Dcpp_link_args={}", link_args));
        }

        if cfg!(target_os = "windows") {
            let vscrt = match env::var("PROFILE").ok().as_deref() {
                Some("debug") => "mdd",
                _ => "md",
            };
            meson.arg(format!("-Db_vscrt={vscrt}"));
        }

        let status = meson
            .arg("-Ddefault_library=static")
            .arg("-Dcpp_std=c++20")
            .arg(source_dir.to_str().unwrap())
            .arg(build_dir.to_str().unwrap())
            .status()
            .context("Failed to execute meson. Do you have it installed?")?;
        assert!(status.success(), "Command failed: {:?}", &meson);

        let mut ninja = Command::new("ninja");
        let status = ninja
            .current_dir(&build_dir)
            .arg("-v")
            .status()
            .context("Failed to execute ninja. Do you have it installed?")?;
        if !status.success() {
            print_meson_log_tail(&build_dir);
        }
        assert!(status.success(), "Command failed: {:?}", &ninja);

        let mut install = Command::new("ninja");
        let status = install
            .current_dir(&build_dir)
            .arg("-v")
            .arg("install")
            .status()
            .context("Failed to execute ninja install")?;
        if !status.success() {
            print_meson_log_tail(&build_dir);
        }
        assert!(status.success(), "Command failed: {:?}", &install);

        Ok(())
    }

    fn create_windows_link_aliases(build_dir: &Path, install_dir: &Path) -> Result<()> {
        #[cfg(not(target_os = "windows"))]
        {
            let _ = build_dir;
            let _ = install_dir;
            return Ok(());
        }

        #[cfg(target_os = "windows")]
        {
            let install_lib_dir = install_dir.join("lib");
            fs::create_dir_all(&install_lib_dir)?;

            create_windows_lib_alias(
                &install_lib_dir.join(format!("lib{LIB_NAME}.a")),
                &install_lib_dir.join(format!("{LIB_NAME}.lib")),
            )?;

            let absl_build_dir = build_dir
                .join("subprojects")
                .join("abseil-cpp-20240722.0");

            if absl_build_dir.exists() {
                for entry in fs::read_dir(&absl_build_dir)? {
                    let entry = entry?;
                    let path = entry.path();
                    if !entry.file_type()?.is_file() {
                        continue;
                    }

                    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
                        continue;
                    };

                    if !file_name.starts_with("libabsl_") || !file_name.ends_with(".a") {
                        continue;
                    }

                    let alias_name = format!(
                        "{}.lib",
                        file_name
                            .trim_start_matches("lib")
                            .trim_end_matches(".a")
                    );
                    create_windows_lib_alias(&path, &install_lib_dir.join(alias_name))?;
                }
            }

            Ok(())
        }
    }

    fn create_windows_lib_alias(source: &Path, target: &Path) -> Result<()> {
        if !source.exists() {
            return Ok(());
        }

        if target.exists() {
            fs::remove_file(target)
                .with_context(|| format!("Failed to remove {}", target.display()))?;
        }

        fs::copy(source, target).with_context(|| {
            format!(
                "Failed to copy {} to {}",
                source.display(),
                target.display()
            )
        })?;

        Ok(())
    }

    pub(super) fn prefix_library_symbols(
        lib_dirs: &[PathBuf],
        prefix: &str,
    ) -> Result<Vec<String>> {
        let static_lib_filename = format!("lib{LIB_NAME}.a");

        for lib_dir in lib_dirs {
            let lib_path = lib_dir.join(&static_lib_filename);
            if lib_path.exists() {
                let symbols = get_defined_symbols(&lib_path)?;
                prefix_archive_symbols(&lib_path, &symbols, prefix)?;
                create_windows_link_aliases(
                    &bundled_work_dir().join(BUNDLED_BUILD_PATH),
                    &out_dir(),
                )?;
                return Ok(symbols);
            }
        }

        bail!("Cannot find {static_lib_filename} in {lib_dirs:?} to prefix its symbols.");
    }

    fn src_dir() -> PathBuf {
        std::env::var("CARGO_MANIFEST_DIR")
            .expect("CARGO_MANIFEST_DIR environment var not set.")
            .into()
    }

    fn bundled_source_dir() -> PathBuf {
        bundled_work_dir().join(BUNDLED_SOURCE_COPY_PATH)
    }

    fn bundled_work_dir() -> PathBuf {
        #[cfg(target_os = "windows")]
        {
            let out = out_dir();
            let unique = out
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("wap");
            return std::env::temp_dir().join("wap-sys").join(unique);
        }

        #[cfg(not(target_os = "windows"))]
        {
            out_dir()
        }
    }

    fn copy_dir_recursively(source: &Path, target: &Path) -> Result<()> {
        fs::create_dir_all(target)
            .with_context(|| format!("Failed to create {}", target.display()))?;

        for entry in fs::read_dir(source)
            .with_context(|| format!("Failed to read {}", source.display()))?
        {
            let entry = entry?;
            let entry_type = entry.file_type()?;
            let source_path = entry.path();
            let target_path = target.join(entry.file_name());

            if entry_type.is_dir() {
                copy_dir_recursively(&source_path, &target_path)?;
            } else if entry_type.is_file() {
                fs::copy(&source_path, &target_path).with_context(|| {
                    format!(
                        "Failed to copy {} to {}",
                        source_path.display(),
                        target_path.display()
                    )
                })?;
            }
        }

        Ok(())
    }

    fn print_meson_log_tail(build_dir: &Path) {
        let log_path = build_dir.join("meson-logs").join("meson-log.txt");
        let Ok(file) = fs::File::open(&log_path) else {
            eprintln!("Meson log not found at {}", log_path.display());
            return;
        };

        let lines = BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .collect::<Vec<_>>();

        let start = lines.len().saturating_sub(200);
        eprintln!("--- meson-log.txt (last {} lines) ---", lines.len() - start);
        for line in &lines[start..] {
            eprintln!("{line}");
        }
        eprintln!("--- end meson-log.txt ---");
    }

    fn get_defined_symbols(archive_path: &Path) -> Result<Vec<String>> {
        let nm = determine_nm_path()?;
        let output = Command::new(&nm)
            .arg("--defined-only")
            .arg("--format=posix")
            .arg(archive_path)
            .output()
            .context(format!("Failed to execute {:?}", nm))?;

        if !output.status.success() {
            anyhow::bail!("{:?} failed: {}", nm, String::from_utf8_lossy(&output.stderr));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut symbols = HashSet::new();

        for line in stdout.lines() {
            if let Some(symbol) = line.split_whitespace().next() {
                symbols.insert(symbol.to_string());
            }
        }

        Ok(symbols.into_iter().collect())
    }
}

#[derive(Debug)]
struct CustomDeriveCallbacks;

impl ParseCallbacks for CustomDeriveCallbacks {
    fn add_derives(&self, info: &DeriveInfo) -> Vec<String> {
        if info.name.starts_with("EchoCanceller3Config") && cfg!(feature = "serde") {
            vec!["serde::Deserialize".into(), "serde::Serialize".into()]
        } else if info.name.starts_with("AudioProcessing_Config") {
            vec!["Default".into()]
        } else {
            vec![]
        }
    }

    fn add_attributes(&self, info: &AttributeInfo<'_>) -> Vec<String> {
        if info.name.starts_with("EchoCanceller3Config") {
            vec!["#[non_exhaustive]".into()]
        } else {
            vec![]
        }
    }
}

fn main() -> Result<()> {
    webrtc::build_if_necessary()?;
    let (include_dirs, lib_dirs) = webrtc::get_build_paths()?;

    let renamed_symbols = webrtc::prefix_library_symbols(&lib_dirs, SYMBOL_PREFIX)?;

    for dir in &lib_dirs {
        println!("cargo:rustc-link-search=native={}", dir.display());
    }

    if cfg!(target_os = "macos") {
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
    }

    let mut cc_build = cc::Build::new();

    if cfg!(feature = "experimental-aec3-config") {
        cc_build.define("WEBRTC_AEC3_CONFIG", None);
    }

    if cfg!(target_os = "macos") {
        let min_version = match env::var(MACOSX_DEPLOYMENT_TARGET_VAR) {
            Ok(ver) => ver,
            Err(_) => String::from(match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
                "x86_64" => "10.10",
                "aarch64" => "11.0",
                arch => panic!("unknown arch: {}", arch),
            }),
        };

        cc_build.flag(format!("-mmacos-version-min={}", min_version));
    }

    cc_build.cpp(true).file("src/wrapper.cpp").includes(&include_dirs);

    if cc_build.get_compiler().is_like_msvc() {
        cc_build.flag("/std:c++20").flag("/wd4100");
    } else {
        cc_build.flag("-std=c++20").flag("-Wno-unused-parameter");
    }

    cc_build
        .out_dir(out_dir())
        .compile("webrtc_audio_processing_wrapper");

    println!("cargo:rerun-if-changed=src/wrapper.hpp");
    println!("cargo:rerun-if-changed=src/wrapper.cpp");
    println!("cargo:rerun-if-changed=webrtc-audio-processing");

    prefix_wrapper_artifacts(&out_dir(), &renamed_symbols, SYMBOL_PREFIX)?;

    if cfg!(feature = "bundled") {
        println!("cargo:rustc-link-lib=static={LIB_NAME}");
        println!("cargo:rustc-link-lib=absl_strings");
    } else {
        println!("cargo:rustc-link-lib=dylib={LIB_NAME}");
    }

    configure_libclang_path();

    let binding_file = out_dir().join("bindings.rs");
    let mut builder = bindgen::Builder::default()
        .header("src/wrapper.hpp")
        .clang_args(&["-x", "c++", "-std=c++20", "-fparse-all-comments"])
        .generate_comments(true)
        .enable_cxx_namespaces();

    builder = builder
        .allowlist_function("webrtc_audio_processing_wrapper::.*")
        .opaque_type("std::.*")
        .parse_callbacks(Box::new(CustomDeriveCallbacks))
        .derive_debug(true)
        .derive_default(false)
        .derive_partialeq(true);
    for dir in &include_dirs {
        builder = builder.clang_arg(format!("-I{}", dir.display()));
    }
    builder
        .generate()
        .expect("Unable to generate bindings")
        .write_to_file(&binding_file)
        .expect("Couldn't write bindings!");

    Ok(())
}

fn prefix_wrapper_artifacts(out_dir: &Path, symbols: &[String], prefix: &str) -> Result<()> {
    if symbols.is_empty() {
        return Ok(());
    }

    for entry in std::fs::read_dir(out_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }

        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if file_name == "libwebrtc_audio_processing_wrapper.a"
            || file_name == "webrtc_audio_processing_wrapper.lib"
            || file_name.ends_with("wrapper.o")
            || file_name.ends_with("wrapper.obj")
        {
            prefix_archive_symbols(&entry.path(), symbols, prefix)?;
        }
    }

    Ok(())
}

fn configure_libclang_path() {
    if env::var_os("LIBCLANG_PATH").is_some() {
        return;
    }

    #[cfg(target_os = "windows")]
    {
        for candidate in [
            r"C:\Program Files\LLVM\bin",
            r"C:\Program Files (x86)\LLVM\bin",
        ] {
            let libclang = PathBuf::from(candidate).join("libclang.dll");
            if libclang.exists() {
                env::set_var("LIBCLANG_PATH", candidate);
                println!("cargo:warning=Using libclang from {}", candidate);
                return;
            }
        }
    }
}

fn determine_nm_path() -> Result<PathBuf> {
    if let Some(path) = determine_llvm_tool_path("llvm-nm") {
        return Ok(path);
    }

    Ok(if cfg!(target_os = "windows") {
        PathBuf::from("llvm-nm.exe")
    } else {
        PathBuf::from("nm")
    })
}

fn determine_objcopy_path() -> Result<PathBuf> {
    if let Some(path) = determine_llvm_tool_path("llvm-objcopy") {
        return Ok(path);
    }

    let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
    let output = Command::new(&rustc)
        .arg("--print")
        .arg("sysroot")
        .output()
        .context("Failed to execute rustc to find sysroot")?;

    if !output.status.success() {
        bail!("Failed to get sysroot from rustc: {:?}", output);
    }

    let sysroot_str = String::from_utf8(output.stdout).context("Invalid UTF-8 in sysroot")?;
    let sysroot = PathBuf::from(sysroot_str.trim());
    let host = env::var("HOST").context("HOST env var not found")?;

    let objcopy = sysroot
        .join("lib")
        .join("rustlib")
        .join(host)
        .join("bin")
        .join("rust-objcopy");

    if !objcopy.exists() {
        println!("cargo:warning=rust-objcopy not found at {:?}", objcopy);
        println!(
            "cargo:warning=Ensure the 'llvm-tools' component is installed: 'rustup component add llvm-tools'"
        );
    }

    Ok(objcopy)
}

fn determine_llvm_tool_path(tool_name: &str) -> Option<PathBuf> {
    let executable = if cfg!(target_os = "windows") {
        format!("{tool_name}.exe")
    } else {
        tool_name.to_string()
    };

    if let Some(path) = env::var_os("LIBCLANG_PATH") {
        let candidate = PathBuf::from(path).join(&executable);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    #[cfg(target_os = "windows")]
    for candidate_dir in [
        r"C:\Program Files\LLVM\bin",
        r"C:\Program Files (x86)\LLVM\bin",
    ] {
        let candidate = PathBuf::from(candidate_dir).join(&executable);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}
