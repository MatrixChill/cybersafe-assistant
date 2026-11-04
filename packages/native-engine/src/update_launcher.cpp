// Fixed, non-elevating Windows launcher. No installation logic or shell command.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <vector>
#include <array>
#include <regex>
#include <tuple>
#include "update_launcher_program.h"
#include <wincrypt.h>
#include <bcrypt.h>
#include "monocypher-ed25519.h"

// Ed25519 SPKI SHA-256: 3982C36398918D077A417DDA02E6E7FF6C1F70622684DA4FB43673652E4C8FB6.
static constexpr std::array<uint8_t,32> kPreviewKey{
  0x6d,0x9b,0x98,0xe3,0xe1,0x37,0x44,0x01,0x05,0x67,0x5d,0x83,0x4c,0x7f,0xcd,0x46,
  0x86,0x15,0x33,0x28,0xe8,0xd1,0x20,0x21,0xa8,0x7f,0x29,0x39,0x02,0x3c,0x6d,0x14
};

static bool DecodeBase64(const std::wstring& input, size_t maxLength, std::vector<uint8_t>& out) {
  if (input.empty() || input.size() > maxLength || input.size() % 4 ||
      input.find_first_not_of(L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=") != std::wstring::npos) return false;
  DWORD size = 0;
  const DWORD flags = CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT;
  if (!CryptStringToBinaryW(input.c_str(), static_cast<DWORD>(input.size()), flags, nullptr, &size, nullptr, nullptr)) return false;
  out.resize(size);
  return CryptStringToBinaryW(input.c_str(), static_cast<DWORD>(input.size()), flags, out.data(), &size, nullptr, nullptr)
    && size == out.size();
}

static int ReadSignedPreviewBytes(const wchar_t* bytes, const wchar_t* signature, std::vector<uint8_t>& message) {
  std::vector<uint8_t> sig;
  if (!DecodeBase64(bytes, 24000, message) || !DecodeBase64(signature, 88, sig) || sig.size() != 64) return 2;
  return crypto_ed25519_check(sig.data(), kPreviewKey.data(), message.data(), message.size()) == 0 ? 0 : 7;
}

using Version = std::tuple<unsigned long, unsigned long, unsigned long, unsigned long>;
static bool ParseRc(const std::string& value, Version& parsed) {
  static const std::regex rc(R"((0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})-rc\.([1-9][0-9]{0,8}))");
  std::smatch match;
  if (!std::regex_match(value, match, rc)) return false;
  parsed = {std::stoul(match[1]), std::stoul(match[2]), std::stoul(match[3]), std::stoul(match[4])};
  return true;
}

class LockedArtifact {
 public:
  LockedArtifact() = default;
  LockedArtifact(const LockedArtifact&) = delete;
  LockedArtifact& operator=(const LockedArtifact&) = delete;
  ~LockedArtifact() {
    for (auto it = handles.rbegin(); it != handles.rend(); ++it) CloseHandle(*it);
  }

  bool Open(const wchar_t* input) {
    if (!input) return false;
    path = input;
    if (path.size() < 4 || path.size() >= MAX_PATH ||
        path[1] != L':' || path[2] != L'\\' ||
        path.find_first_of(L"/:*?\"<>|", 2) != std::wstring::npos) return false;
    wchar_t resolved[MAX_PATH]{};
    if (GetFullPathNameW(path.c_str(), MAX_PATH, resolved, nullptr) != path.size() || path != resolved ||
        GetDriveTypeW(path.substr(0, 3).c_str()) != DRIVE_FIXED) return false;
    size_t start = 3;
    while (start < path.size()) {
      const auto end = path.find(L'\\', start);
      const auto part = path.substr(start, end == std::wstring::npos ? end : end - start);
      if (part.empty() || part.back() == L'.' || part.back() == L' ') return false;
      const bool directory = end != std::wstring::npos;
      const auto prefix = directory ? path.substr(0, end) : path;
      HANDLE handle = CreateFileW(prefix.c_str(), directory ? 0 : GENERIC_READ,
        FILE_SHARE_READ,
        nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT |
        (directory ? FILE_FLAG_BACKUP_SEMANTICS : FILE_FLAG_SEQUENTIAL_SCAN), nullptr);
      if (handle == INVALID_HANDLE_VALUE) return false;
      handles.push_back(handle);
      BY_HANDLE_FILE_INFORMATION info{};
      if (GetFileType(handle) != FILE_TYPE_DISK || !GetFileInformationByHandle(handle, &info) ||
          (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
          ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory) return false;
      if (!directory) { file = handle; return true; }
      start = end + 1;
    }
    return false;
  }

  HANDLE file = INVALID_HANDLE_VALUE;
 private:
  std::wstring path;
  std::vector<HANDLE> handles;
};

static bool MatchLockedArtifact(HANDLE file, unsigned long long expectedSize, const std::string& expectedHash) {
  BY_HANDLE_FILE_INFORMATION info{};
  bool ok = GetFileInformationByHandle(file, &info) &&
    ((static_cast<unsigned long long>(info.nFileSizeHigh) << 32) | info.nFileSizeLow) == expectedSize;
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  if (ok) ok = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0;
  if (ok) ok = BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) >= 0;
  std::array<uint8_t, 65536> buffer{};
  unsigned long long readTotal = 0;
  while (ok) {
    DWORD count = 0;
    ok = ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr) != FALSE;
    if (!ok || count == 0) break;
    readTotal += count;
    ok = readTotal <= expectedSize && BCryptHashData(hash, buffer.data(), count, 0) >= 0;
  }
  std::array<uint8_t, 32> digest{};
  if (ok) ok = readTotal == expectedSize && BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) >= 0;
  if (ok) {
    constexpr char hex[] = "0123456789abcdef";
    for (size_t index = 0; index < digest.size(); ++index)
      if (hex[digest[index] >> 4] != expectedHash[2 * index] ||
          hex[digest[index] & 15] != expectedHash[2 * index + 1]) { ok = false; break; }
  }
  if (hash) BCryptDestroyHash(hash);
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  return ok;
}

// Read only the exact signed canonical representation. Reject duplicate keys,
// unknown fields, alternate URL spellings and unexpected JSON representations.
static int InspectPreviewManifest(const wchar_t* bytes, const wchar_t* signature,
                                  const wchar_t* installed, const wchar_t* windowsBuild, const wchar_t* artifact) {
  std::vector<uint8_t> message;
  const int result = ReadSignedPreviewBytes(bytes, signature, message);
  if (result != 0) return result;
  if (message.size() > 4096) return 8;
  static const std::regex manifest(
    R"json(\{"schema":"cybersafe-release/1","channel":"preview","version":"([0-9.rc-]{1,40})","publishedAt":"([0-9TZ:.+-]{1,35})","notes":"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*","file":\{"url":"https://github\.com/MatrixChill/cybersafe-assistant/releases/download/v([0-9.rc-]{1,40})/([A-Za-z0-9._-]{1,180}\.exe)","sha256":"([a-f0-9]{64})","sizeBytes":([1-9][0-9]{0,9})\},"publisher":\{"name":"CyberSafe Preview \(sem Authenticode\)"\},"requiresElevation":false(?:,"buildId":"[A-Za-z0-9._-]{1,64}")?,"sourceCommit":"[a-f0-9]{40}","compatibility":\{"minWindowsBuild":([1-9][0-9]{0,8}),"fromVersion":(null|"[0-9.]{5,29}")\}\})json");
  const std::string canonical(message.begin(), message.end());
  std::smatch match;
  if (!std::regex_match(canonical, match, manifest) || match[1] != match[3] ||
      std::stoull(match[6]) > 1024ull * 1024 * 1024) return 8;
  const std::wstring current(installed), build(windowsBuild);
  if (current.size() > 40 || current.find_first_not_of(L"0123456789.rc-") != std::wstring::npos ||
      build.empty() || build.size() > 9 || build.find_first_not_of(L"0123456789") != std::wstring::npos) return 8;
  std::string asciiVersion;
  for (const wchar_t c : current) asciiVersion.push_back(static_cast<char>(c));
  Version source, target;
  if (!ParseRc(asciiVersion, source) ||
      !ParseRc(match[1], target) || target <= source ||
      std::stoul(build) < std::stoul(match[7])) return 8;
  if (match[8] != "null") {
    const auto minimum = match[8].str();
    Version min;
    if (!ParseRc(minimum.substr(1, minimum.size()-2) + "-rc.1", min) || source < min) return 8;
  }
  if (!artifact) return 0;
  LockedArtifact locked;
  return locked.Open(artifact) && MatchLockedArtifact(locked.file, std::stoull(match[6]), match[5]) ? 0 : 9;
}

int wmain(int argc, wchar_t** argv) {
  if (argc == 4 && std::wstring(argv[1]) == L"--verify-preview-signature") {
    std::vector<uint8_t> message;
    return ReadSignedPreviewBytes(argv[2], argv[3], message);
  }
  // Diagnostic mode only. These inputs do not authorize execution.
  if ((argc == 6 || argc == 7) && std::wstring(argv[1]) == L"--inspect-preview-manifest")
    return InspectPreviewManifest(argv[2], argv[3], argv[4], argv[5], argc == 7 ? argv[6] : nullptr);
  if (argc != 2) return 2;
  const std::wstring encoded(argv[1]);
  // Base64 is an encoding, not an authorization to run caller-supplied code.
  if (encoded != kHandoffProgram) return 2;
  wchar_t windows[MAX_PATH + 1]{};
  const UINT size = GetWindowsDirectoryW(windows, MAX_PATH);
  if (!size || size >= MAX_PATH) return 3;
  const std::wstring executable = std::wstring(windows) + L"\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const std::wstring command = L"\"" + executable + L"\" -NoLogo -NoProfile -NonInteractive -EncodedCommand " + encoded;
  std::vector<wchar_t> mutableCommand(command.begin(), command.end());
  mutableCommand.push_back(L'\0');
  std::array<HANDLE, 3> handles{GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE)};
  for (const HANDLE handle : handles) {
    if (!handle || handle == INVALID_HANDLE_VALUE ||
        !SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) return 5;
  }
  SIZE_T bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
  auto attributes = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, bytes));
  if (!attributes) return 5;
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &bytes)) {
    HeapFree(GetProcessHeap(), 0, attributes); return 5;
  }
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                 handles.data(), handles.size() * sizeof(HANDLE), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attributes); HeapFree(GetProcessHeap(), 0, attributes); return 5;
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = handles[0];
  startup.StartupInfo.hStdOutput = handles[1];
  startup.StartupInfo.hStdError = handles[2];
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION process{};
  const DWORD flags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB | EXTENDED_STARTUPINFO_PRESENT;
  const BOOL created = CreateProcessW(executable.c_str(), mutableCommand.data(), nullptr, nullptr,
                      TRUE, flags, nullptr, nullptr, &startup.StartupInfo, &process);
  DeleteProcThreadAttributeList(attributes);
  HeapFree(GetProcessHeap(), 0, attributes);
  if (!created) {
    // A job that disallows breakaway is a real blocker; do not silently weaken it.
    return 4;
  }
  CloseHandle(process.hThread);
  // Keep the inherited control pipes alive while the controller is validating.
  // The actual helper is breakaway; it can survive this launcher/job as well.
  DWORD childExit = 1;
  const bool exited = WaitForSingleObject(process.hProcess, INFINITE) == WAIT_OBJECT_0
    && GetExitCodeProcess(process.hProcess, &childExit);
  CloseHandle(process.hProcess);
  return exited ? static_cast<int>(childExit) : 6;
}
