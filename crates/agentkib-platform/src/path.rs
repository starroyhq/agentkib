use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

pub fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    fs::canonicalize(path).map(strip_verbatim_prefix)
}

/// Assign session cwd to one project only, using the same rule in discovery and history.
/// The caller supplies its resolved user home so global instruction files do not
/// turn every unmarked directory into one home-wide workspace.
pub fn session_workspace_root(path: &Path, home: Option<&Path>) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let cwd = canonicalize(path).ok()?;
    let home = home.and_then(|value| canonicalize(value).ok());
    if !cwd.is_dir() || cwd.parent().is_none() || home.as_ref() == Some(&cwd) {
        return None;
    }
    for parent in cwd.ancestors() {
        if parent.parent().is_none() || home.as_deref() == Some(parent) {
            break;
        }
        if [
            ".agentkib",
            ".git",
            "AGENTS.md",
            "CLAUDE.md",
            ".codex",
            ".claude",
            ".cursor",
            ".opencode",
            "opencode.json",
            "opencode.jsonc",
            ".grok",
            ".dsh",
        ]
        .iter()
        .any(|marker| parent.join(marker).exists())
        {
            return Some(parent.to_path_buf());
        }
    }
    Some(cwd)
}

/// Resolve an existing path prefix and append only ordinary missing components.
/// This avoids trusting lexical `..` components in paths that do not exist yet.
pub fn canonicalize_allow_missing(path: &Path) -> io::Result<PathBuf> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path must not contain parent components",
        ));
    }
    if path.exists() {
        return canonicalize(path);
    }
    let mut current = path;
    let mut suffix = Vec::new();
    while !current.exists() {
        let name = match current.components().next_back() {
            Some(Component::Normal(name)) => name,
            Some(
                Component::Prefix(_)
                | Component::RootDir
                | Component::CurDir
                | Component::ParentDir,
            )
            | None => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "missing path suffix must contain only normal components",
                ));
            }
        };
        suffix.push(name.to_os_string());
        current = current.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "path has no existing ancestor")
        })?;
    }
    let mut resolved = canonicalize(current)?;
    for component in suffix.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

/// Stable path identity used for deduplication and containment comparisons.
pub fn identity(path: &Path) -> String {
    let path = identity_path(path);
    identity_for_platform(&path.to_string_lossy(), cfg!(windows))
}

/// Path-shaped identity for salted keys. Preserve Unix OS bytes while applying
/// Windows comparison rules, including when the final directory no longer exists.
pub fn identity_path(path: &Path) -> PathBuf {
    let normalized = normalize_identity_path(path);
    #[cfg(windows)]
    {
        PathBuf::from(identity_for_platform(&normalized.to_string_lossy(), true))
    }
    #[cfg(not(windows))]
    {
        normalized
    }
}

fn normalize_identity_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        canonicalize_allow_missing(path)
            .or_else(|_| canonicalize(path))
            .unwrap_or_else(|_| strip_verbatim_prefix(path.to_path_buf()))
    }
    #[cfg(not(windows))]
    {
        canonicalize(path).unwrap_or_else(|_| strip_verbatim_prefix(path.to_path_buf()))
    }
}

pub fn equivalent(left: &Path, right: &Path) -> bool {
    identity(left) == identity(right)
}

pub fn starts_with(path: &Path, base: &Path) -> bool {
    let path = identity(path);
    let base = identity(base);
    identity_starts_with(&path, &base, cfg!(windows))
}

fn identity_starts_with(path: &str, base: &str, windows: bool) -> bool {
    if path == base {
        return true;
    }
    let separator = if windows { '\\' } else { '/' };
    if base.ends_with(separator) {
        return path.starts_with(base);
    }
    path.strip_prefix(base)
        .is_some_and(|suffix| suffix.starts_with(separator))
}

pub fn file_uri_to_path(value: &str) -> Option<PathBuf> {
    file_uri_to_path_for_platform(value, cfg!(windows))
}

pub fn is_reparse_or_symlink(path: &Path) -> io::Result<bool> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        Ok(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

pub fn is_safe_scan_entry(path: &Path) -> bool {
    is_reparse_or_symlink(path).is_ok_and(|unsafe_link| !unsafe_link)
}

/// Returns whether the directory belongs to a known synthetic Agent probe.
///
/// CodexBar runs Claude Code in a dedicated working directory and marks it with
/// this file. It is operational state owned by another tool, not a user project.
pub fn is_known_agent_probe_workspace(path: &Path) -> bool {
    fs::symlink_metadata(path.join(".codexbar-session-id"))
        .is_ok_and(|metadata| metadata.file_type().is_file())
}

fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix("\\\\?\\UNC\\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix("\\\\?\\") {
            return PathBuf::from(rest);
        }
    }
    path
}

fn identity_for_platform(value: &str, windows: bool) -> String {
    if windows {
        let value = value
            .strip_prefix("\\\\?\\UNC\\")
            .map(|rest| format!(r"\\{rest}"))
            .or_else(|| value.strip_prefix("\\\\?\\").map(str::to_owned))
            .unwrap_or_else(|| value.to_owned());
        let normalized = value.replace('/', "\\").to_lowercase();
        trim_separators(normalized, '\\')
    } else {
        trim_separators(value.to_owned(), '/')
    }
}

fn trim_separators(mut value: String, separator: char) -> String {
    while value.len() > 1 && value.ends_with(separator) {
        if separator == '\\' && value.len() == 3 && value.as_bytes().get(1) == Some(&b':') {
            break;
        }
        value.pop();
    }
    value
}

fn file_uri_to_path_for_platform(value: &str, windows: bool) -> Option<PathBuf> {
    let encoded = value.strip_prefix("file://")?;
    let decoded = percent_decode(encoded)?;
    if windows {
        let mut normalized = decoded.replace('/', "\\");
        if let Some(rest) = normalized.strip_prefix("localhost\\") {
            normalized = rest.to_owned();
        }
        if let Some(rest) = normalized.strip_prefix(r"\\") {
            return Some(PathBuf::from(format!(r"\\{rest}")));
        }
        if normalized.starts_with('\\')
            && normalized.as_bytes().get(2) == Some(&b':')
            && normalized
                .as_bytes()
                .get(1)
                .is_some_and(u8::is_ascii_alphabetic)
        {
            return Some(PathBuf::from(&normalized[1..]));
        }
        if normalized.as_bytes().get(1) == Some(&b':') {
            return Some(PathBuf::from(normalized));
        }
        return Some(PathBuf::from(format!(r"\\{normalized}")));
    }
    Some(PathBuf::from(decoded))
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = *bytes.get(index + 1)?;
            let low = *bytes.get(index + 2)?;
            decoded.push((hex_digit(high)? << 4) | hex_digit(low)?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_identity_ignores_case_and_verbatim_prefix() {
        assert_eq!(
            identity_for_platform(r"\\?\C:\Dev\AgentKib", true),
            identity_for_platform(r"c:/dev/agentkib/", true)
        );
        assert_eq!(
            identity_for_platform(r"\\?\UNC\server\Share\repo", true),
            identity_for_platform(r"\\server\share\REPO", true)
        );
    }

    #[test]
    fn parses_windows_drive_and_unc_file_uris() {
        assert_eq!(
            file_uri_to_path_for_platform("file:///C:/dev/Agent%20Kib", true),
            Some(PathBuf::from(r"C:\dev\Agent Kib"))
        );
        assert_eq!(
            file_uri_to_path_for_platform("file://server/share/repo", true),
            Some(PathBuf::from(r"\\server\share\repo"))
        );
    }

    #[test]
    fn windows_containment_requires_a_component_boundary() {
        let project = identity_for_platform(r"C:\Dev\App", true);
        let child = identity_for_platform(r"c:\dev\app\src", true);
        let sibling = identity_for_platform(r"c:\dev\application", true);
        assert!(identity_starts_with(&child, &project, true));
        assert!(!identity_starts_with(&sibling, &project, true));
        assert!(identity_starts_with(
            &identity_for_platform(r"C:\Dev", true),
            &identity_for_platform(r"C:\", true),
            true
        ));
    }

    #[test]
    fn missing_path_rejects_parent_components() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("missing/../../outside/file.txt");
        assert_eq!(
            canonicalize_allow_missing(&path).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn parses_unix_file_uri() {
        assert_eq!(
            file_uri_to_path("file:///tmp/a%20b"),
            Some(PathBuf::from("/tmp/a b"))
        );
    }

    #[test]
    fn recognizes_codexbar_claude_probe_workspace() {
        let directory = tempfile::tempdir().unwrap();
        assert!(!is_known_agent_probe_workspace(directory.path()));

        fs::write(directory.path().join(".codexbar-session-id"), "probe").unwrap();
        assert!(is_known_agent_probe_workspace(directory.path()));
    }

    #[test]
    fn session_workspace_uses_nearest_project_and_keeps_unmarked_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("project");
        let child = parent.join("nested");
        let cwd = child.join("src");
        fs::create_dir_all(&cwd).unwrap();
        fs::write(parent.join("AGENTS.md"), "").unwrap();
        fs::write(child.join("CLAUDE.md"), "").unwrap();
        assert_eq!(
            session_workspace_root(&cwd, Some(dir.path())),
            Some(canonicalize(&child).unwrap())
        );
        let plain = dir.path().join("plain");
        fs::create_dir(&plain).unwrap();
        fs::write(dir.path().join("CLAUDE.md"), "").unwrap();
        assert_eq!(
            session_workspace_root(&plain, Some(dir.path())),
            Some(canonicalize(&plain).unwrap())
        );
        assert_eq!(session_workspace_root(dir.path(), Some(dir.path())), None);
        assert_eq!(session_workspace_root(Path::new("relative"), None), None);
        assert_eq!(
            session_workspace_root(&dir.path().join("missing"), None),
            None
        );
    }
}
