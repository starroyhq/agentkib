use std::fs;
use std::io::{self, Write};
use std::path::Path;

use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

/// Stable Windows file identity, independent of timestamps retained by replacement.
#[cfg(windows)]
pub fn file_identity(file: &fs::File) -> io::Result<String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ID_INFO, FileIdInfo, GetFileInformationByHandleEx,
    };

    let mut info = std::mem::MaybeUninit::<FILE_ID_INFO>::uninit();
    // SAFETY: the borrowed File keeps the handle alive and the buffer has the
    // size required by FileIdInfo. Read the initialized buffer only on success.
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if succeeded == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: GetFileInformationByHandleEx successfully initialized FILE_ID_INFO.
    let info = unsafe { info.assume_init() };
    Ok(format!(
        "win-file-id:{}:{}",
        info.VolumeSerialNumber,
        hex::encode(info.FileId.Identifier)
    ))
}

#[derive(Debug, Clone, Copy)]
pub enum ExpectedFile<'a> {
    Any,
    Missing,
    Sha256(&'a str),
}

pub fn atomic_write(path: &Path, content: &[u8]) -> io::Result<()> {
    atomic_write_checked(path, content, ExpectedFile::Any)
}

pub fn atomic_write_checked(
    path: &Path,
    content: &[u8],
    expected: ExpectedFile<'_>,
) -> io::Result<()> {
    verify_expected(path, expected)?;
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no parent"))?;
    fs::create_dir_all(parent)?;
    let mut temp = NamedTempFile::new_in(parent)?;
    temp.write_all(content)?;
    if let Ok(metadata) = fs::metadata(path) {
        temp.as_file_mut().set_permissions(metadata.permissions())?;
    }
    temp.as_file_mut().sync_all()?;
    // Windows cannot replace an open file. Converting to TempPath closes the
    // handle while retaining cleanup ownership until the move completes.
    let temp_path = temp.into_temp_path();
    atomic_replace(&temp_path, path)
}

pub fn atomic_replace(source: &Path, target: &Path) -> io::Result<()> {
    atomic_replace_checked(source, target, ExpectedFile::Any)
}

/// Move a file or directory to a target that must not already exist.
/// This is used for directory swaps, which `ReplaceFileW` cannot perform.
pub fn move_path(source: &Path, target: &Path) -> io::Result<()> {
    if target.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("move target already exists: {}", target.display()),
        ));
    }
    #[cfg(windows)]
    {
        windows::move_path(source, target)
    }
    #[cfg(not(windows))]
    {
        fs::rename(source, target)
    }
}

pub fn atomic_replace_checked(
    source: &Path,
    target: &Path,
    expected: ExpectedFile<'_>,
) -> io::Result<()> {
    verify_expected(target, expected)?;
    #[cfg(windows)]
    {
        windows::atomic_replace(source, target)
    }
    #[cfg(not(windows))]
    {
        fs::rename(source, target)
    }
}

fn verify_expected(path: &Path, expected: ExpectedFile<'_>) -> io::Result<()> {
    match expected {
        ExpectedFile::Any => Ok(()),
        ExpectedFile::Missing if !path.exists() => Ok(()),
        ExpectedFile::Missing => Err(conflict_error(path)),
        ExpectedFile::Sha256(expected) => {
            let content = fs::read(path).map_err(|error| {
                if error.kind() == io::ErrorKind::NotFound {
                    conflict_error(path)
                } else {
                    error
                }
            })?;
            let actual = hex::encode(Sha256::digest(content));
            if actual == expected {
                Ok(())
            } else {
                Err(conflict_error(path))
            }
        }
    }
}

fn conflict_error(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("file was modified externally: {}", path.display()),
    )
}

#[cfg(windows)]
mod windows {
    use std::ffi::OsStr;
    use std::fs;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::ptr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::Duration;

    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW, REPLACEFILE_WRITE_THROUGH,
        ReplaceFileW,
    };

    static BACKUP_COUNTER: AtomicU64 = AtomicU64::new(0);
    const RETRIES: [Duration; 5] = [
        Duration::from_millis(0),
        Duration::from_millis(25),
        Duration::from_millis(50),
        Duration::from_millis(100),
        Duration::from_millis(200),
    ];

    pub(super) fn atomic_replace(source: &Path, target: &Path) -> io::Result<()> {
        let source_wide = wide(source);
        let target_wide = wide(target);
        let backup = backup_path(target);
        let backup_wide = wide(&backup);
        let target_exists = target.exists();
        let mut last_error = None;
        for delay in RETRIES {
            if !delay.is_zero() {
                thread::sleep(delay);
            }
            let succeeded = unsafe {
                if target_exists {
                    ReplaceFileW(
                        target_wide.as_ptr(),
                        source_wide.as_ptr(),
                        backup_wide.as_ptr(),
                        REPLACEFILE_WRITE_THROUGH,
                        ptr::null_mut(),
                        ptr::null_mut(),
                    )
                } else {
                    MoveFileExW(
                        source_wide.as_ptr(),
                        target_wide.as_ptr(),
                        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                    )
                }
            };
            if succeeded != 0 {
                let _ = fs::remove_file(&backup);
                return Ok(());
            }
            last_error = Some(io::Error::last_os_error());
        }
        if !target.exists() && backup.exists() {
            let _ = unsafe {
                MoveFileExW(
                    backup_wide.as_ptr(),
                    target_wide.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            };
        }
        Err(last_error.unwrap_or_else(io::Error::last_os_error))
    }

    pub(super) fn move_path(source: &Path, target: &Path) -> io::Result<()> {
        let source_wide = wide(source);
        let target_wide = wide(target);
        let mut last_error = None;
        for delay in RETRIES {
            if !delay.is_zero() {
                thread::sleep(delay);
            }
            if unsafe {
                MoveFileExW(
                    source_wide.as_ptr(),
                    target_wide.as_ptr(),
                    MOVEFILE_WRITE_THROUGH,
                )
            } != 0
            {
                return Ok(());
            }
            last_error = Some(io::Error::last_os_error());
        }
        Err(last_error.unwrap_or_else(io::Error::last_os_error))
    }

    fn backup_path(target: &Path) -> PathBuf {
        loop {
            let counter = BACKUP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let name = target.file_name().unwrap_or_else(|| OsStr::new("file"));
            let mut backup_name = name.to_os_string();
            backup_name.push(format!(".agentkib-backup-{}-{counter}", std::process::id()));
            let candidate = target.with_file_name(backup_name);
            if !candidate.exists() {
                return candidate;
            }
        }
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[cfg(windows)]
    #[test]
    fn file_identity_is_stable_and_distinguishes_matching_timestamps() {
        use std::os::windows::fs::FileTimesExt;

        let directory = tempdir().unwrap();
        let original = directory.path().join("original");
        let replacement = directory.path().join("replacement");
        fs::write(&original, b"old").unwrap();
        fs::write(&replacement, b"new").unwrap();
        let file = fs::File::open(&original).unwrap();
        let metadata = file.metadata().unwrap();
        let times = fs::FileTimes::new()
            .set_created(metadata.created().unwrap())
            .set_modified(metadata.modified().unwrap());
        let replacement_file = fs::OpenOptions::new()
            .write(true)
            .open(&replacement)
            .unwrap();
        replacement_file.set_times(times).unwrap();
        assert_eq!(
            metadata.created().unwrap(),
            replacement_file.metadata().unwrap().created().unwrap()
        );
        let identity = file_identity(&file).unwrap();
        assert_eq!(
            identity,
            file_identity(&fs::File::open(&original).unwrap()).unwrap()
        );
        assert_ne!(identity, file_identity(&replacement_file).unwrap());
    }

    #[test]
    fn atomically_replaces_existing_file() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("settings.json");
        fs::write(&path, b"old").unwrap();
        let expected = hex::encode(Sha256::digest(b"old"));
        atomic_write_checked(&path, b"new", ExpectedFile::Sha256(&expected)).unwrap();
        assert_eq!(fs::read(path).unwrap(), b"new");
    }

    #[test]
    fn rejects_stale_expected_hash() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("settings.json");
        fs::write(&path, b"changed").unwrap();
        let error = atomic_write_checked(&path, b"new", ExpectedFile::Sha256("stale")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(fs::read(path).unwrap(), b"changed");
    }

    #[test]
    fn moves_directory_when_target_is_missing() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("source");
        let target = directory.path().join("target");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("value"), "ok").unwrap();
        move_path(&source, &target).unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read_to_string(target.join("value")).unwrap(), "ok");
    }
}
