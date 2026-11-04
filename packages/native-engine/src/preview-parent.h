#pragma once
#include <tlhelp32.h>

// The Preview trust boundary is the installed, same-user application, not an
// Authenticode identity. A process able to rewrite that installation is outside
// this boundary. Never accept a caller-supplied PID/path as proof of identity.
class PreviewParent {
 public:
  ~PreviewParent() { if (process) CloseHandle(process); }
  HANDLE process = nullptr;

  bool Validate() {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return false;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    DWORD parentId = 0;
    if (Process32FirstW(snapshot, &entry)) do {
      if (entry.th32ProcessID == GetCurrentProcessId()) { parentId = entry.th32ParentProcessID; break; }
    } while (Process32NextW(snapshot, &entry));
    CloseHandle(snapshot);
    if (!parentId) return false;
    process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, parentId);
    if (!process || WaitForSingleObject(process, 0) != WAIT_TIMEOUT) return false;
    HANDLE parentToken=nullptr, selfToken=nullptr;
    if (!OpenProcessToken(process,TOKEN_QUERY,&parentToken)) return false;
    if (!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&selfToken)) { CloseHandle(parentToken); return false; }
    DWORD parentSize=0,selfSize=0;
    GetTokenInformation(parentToken,TokenUser,nullptr,0,&parentSize);
    GetTokenInformation(selfToken,TokenUser,nullptr,0,&selfSize);
    std::vector<uint8_t> parentUser(parentSize),selfUser(selfSize);
    const bool sameUser=parentSize && selfSize &&
      GetTokenInformation(parentToken,TokenUser,parentUser.data(),parentSize,&parentSize) &&
      GetTokenInformation(selfToken,TokenUser,selfUser.data(),selfSize,&selfSize) &&
      EqualSid(reinterpret_cast<TOKEN_USER*>(parentUser.data())->User.Sid,reinterpret_cast<TOKEN_USER*>(selfUser.data())->User.Sid);
    CloseHandle(parentToken);CloseHandle(selfToken);
    if(!sameUser) return false;
    FILETIME parentCreated{}, selfCreated{}, exited{}, kernel{}, user{};
    if (!GetProcessTimes(process, &parentCreated, &exited, &kernel, &user) ||
        !GetProcessTimes(GetCurrentProcess(), &selfCreated, &exited, &kernel, &user) ||
        CompareFileTime(&parentCreated, &selfCreated) > 0) return false;
    wchar_t parentPath[MAX_PATH]{}, selfPath[MAX_PATH]{};
    DWORD length = MAX_PATH;
    const DWORD selfLength=GetModuleFileNameW(nullptr,selfPath,MAX_PATH);
    if (!QueryFullProcessImageNameW(process, 0, parentPath, &length) || length >= MAX_PATH ||
        !selfLength || selfLength>=MAX_PATH) return false;
    const std::wstring image(parentPath);
    const auto separator = image.find_last_of(L'\\');
    if (separator == std::wstring::npos || image.substr(separator + 1) != L"CyberSafe Assistant.exe") return false;
    const auto installation = image.substr(0, separator);
    bool registered = false;
    for (const DWORD view : {RRF_SUBKEY_WOW6464KEY, RRF_SUBKEY_WOW6432KEY}) {
      wchar_t destination[MAX_PATH]{}, version[64]{};
      DWORD destinationBytes = sizeof(destination), versionBytes = sizeof(version);
#ifdef CYBERSAFE_LAUNCHER_LAB
      constexpr auto key = L"Software\\CyberSafeLauncherLabOnly";
#else
      constexpr auto key = L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\7f4c0981-4cbf-53f9-af6e-a266427c7961";
#endif
      if (RegGetValueW(HKEY_CURRENT_USER, key, L"InstallLocation", RRF_RT_REG_SZ | view,
                      nullptr, destination, &destinationBytes) != ERROR_SUCCESS ||
          RegGetValueW(HKEY_CURRENT_USER, key, L"DisplayVersion", RRF_RT_REG_SZ | view,
                      nullptr, version, &versionBytes) != ERROR_SUCCESS) continue;
      std::wstring target(destination);
      if (!target.empty() && target.back() == L'\\') target.pop_back();
      if (_wcsicmp(target.c_str(), installation.c_str()) || std::wstring(version) != CYBERSAFE_LAUNCHER_VERSION) return false;
      registered = true;
    }
    if (!registered) return false;
    // Staging is needed so NSIS can replace the installed helper. Prove that
    // the staged running image has exactly the installed helper's bytes.
    LockedArtifact installed, staged, parentImage;
    const auto installedPath = installation + L"\\resources\\cybersafe-update-launcher.exe";
    if (!installed.Open(installedPath.c_str()) || !staged.Open(selfPath) || !parentImage.Open(parentPath)) return false;
    LARGE_INTEGER first{}, second{};
    if (!GetFileSizeEx(installed.file, &first) || !GetFileSizeEx(staged.file, &second) ||
        first.QuadPart <= 0 || first.QuadPart != second.QuadPart || first.QuadPart > 16 * 1024 * 1024) return false;
    std::array<uint8_t, 65536> a{}, b{};
    for (;;) {
      DWORD countA = 0, countB = 0;
      if (!ReadFile(installed.file, a.data(), static_cast<DWORD>(a.size()), &countA, nullptr) ||
          !ReadFile(staged.file, b.data(), static_cast<DWORD>(b.size()), &countB, nullptr) ||
          countA != countB || !std::equal(a.begin(), a.begin() + countA, b.begin())) return false;
      if (!countA) break;
    }
    for (const DWORD stream : {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE})
      if (GetFileType(GetStdHandle(stream)) != FILE_TYPE_PIPE) return false;
    const auto parent = std::to_wstring(parentId);
    return SetEnvironmentVariableW(L"CS_UPDATE_PARENT", parent.c_str()) != FALSE;
  }
};
