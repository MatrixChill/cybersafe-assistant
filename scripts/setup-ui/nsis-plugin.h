// NSIS ABI 1.0, x86 Unicode. Layout: upstream Source/exehead/api.h.
// Only the NSIS thread accesses its stack. UI messages are synchronous copies.
#pragma once
#include <atomic>
#include <shlwapi.h>
#include <shlobj.h>
#include <fstream>
#include <filesystem>
#include <bcrypt.h>
static_assert(sizeof(void*) == 4, "NSIS requires an x86 plugin");
struct NsisStack { NsisStack* next; wchar_t text[1]; };
struct NsisExtra {
  void* execFlags;
  int (WINAPI* executeCodeSegment)(int, HWND);
  void (WINAPI* validateFilename)(wchar_t*);
  int (WINAPI* registerCallback)(HMODULE, UINT_PTR (__cdecl*)(int));
};
static HMODULE g_module;
static std::atomic<HWND> g_window{nullptr};
static HWND g_pathEdit = nullptr;
static HFONT g_editFont = nullptr;
static HANDLE g_decisionEvent = nullptr, g_uiThread = nullptr;
static std::wstring g_assets, g_version, g_destination, g_installed, g_required;
static bool g_backend = false, g_shortcuts[2] = {true,true};
static bool g_openAvailable = false, g_openRequested = false;
static bool g_mutating = false, g_success = false, g_resultShown = false;
// 0 cancelled/not selected, 1 install, 2 frontend error. Atomic: close may
// race the NSIS stack snapshot, but Begin is serialized on the UI thread.
static std::atomic<int> g_action{0};
static std::wstring g_status = L"A aguardar o motor NSIS.";
static const UINT WM_ORBITAL_PHASE = WM_APP + 1, WM_ORBITAL_RESULT = WM_APP + 2, WM_ORBITAL_STOP = WM_APP + 3, WM_ORBITAL_FALLBACK = WM_APP + 4;
struct NsisExecFlags {
  int autoclose, allUser, error, abort, reboot, rebootCalled, oldType,
      apiVersion, silent, destinationError, rtl, errorLevel;
};
static NsisExecFlags* g_execFlags = nullptr;
static std::wstring PopNsis(NsisStack** top) {
  if(!top || !*top) return L"";
  NsisStack* item = *top; std::wstring value(item->text);
  *top = item->next; GlobalFree(item); return value;
}
static void PushNsis(NsisStack** top, int size, const std::wstring& value) {
  auto item = static_cast<NsisStack*>(GlobalAlloc(GPTR, sizeof(NsisStack) + size * sizeof(wchar_t)));
  if(!item) return;
  lstrcpynW(item->text, value.c_str(), size); item->next = *top; *top = item;
}
// Destination is local, absolute, non-root, canonical and never a reparse path.
// Revalidate immediately before mutation; no directory is created by this check.
static bool ValidDestination(const std::wstring& path) {
  if(path.size() < 4 || path.size() > 220 || !iswalpha(path[0]) || path[1] != L':' || path[2] != L'\\') return false;
  if(path.find_first_of(L"\"<>|?*\r\n/") != std::wstring::npos || path.find(L':',2) != std::wstring::npos) return false;
  wchar_t canonical[MAX_PATH];
  if(!GetFullPathNameW(path.c_str(),MAX_PATH,canonical,nullptr) || _wcsicmp(canonical,path.c_str()) != 0) return false;
  wchar_t system[MAX_PATH]; GetWindowsDirectoryW(system,MAX_PATH);
  std::wstring windows(system);
  if(_wcsicmp(path.c_str(),windows.c_str())==0 || (path.size()>windows.size() && _wcsnicmp(path.c_str(),windows.c_str(),windows.size())==0 && path[windows.size()]==L'\\')) return false;
  for(size_t n=3;n<=path.size();++n) {
    if(n!=path.size() && path[n]!=L'\\') continue;
    const auto part=path.substr(0,n);
    DWORD attr=GetFileAttributesW(part.c_str());
    if(attr!=INVALID_FILE_ATTRIBUTES && ((attr&FILE_ATTRIBUTE_REPARSE_POINT) || !(attr&FILE_ATTRIBUTE_DIRECTORY))) return false;
    const auto leaf=part.substr(part.find_last_of(L'\\')+1);
    if(leaf.empty() || leaf.back()==L'.' || leaf.back()==L' ') return false;
  }
  return true;
}
// Stock electron-builder uninstallation removes the whole installation tree.
// New installs must use an empty product-named directory; never an arbitrary
// existing folder. An upgrade is locked to the registered product location.
static const wchar_t* InstallTargetResult(const std::wstring& path,const std::wstring& registered,const std::wstring& product) {
  if(!ValidDestination(path)) return L"invalid-path";
  if(!registered.empty()) return _wcsicmp(path.c_str(),registered.c_str())==0 ? L"ok" : L"registered-path-mismatch";
  const auto cut=path.find_last_of(L'\\');
  if(cut==std::wstring::npos || _wcsicmp(path.substr(cut+1).c_str(),product.c_str())!=0) return L"product-leaf-mismatch";
  try {
    return !std::filesystem::exists(path) || std::filesystem::is_empty(path) ? L"ok" : L"unregistered-occupied-directory";
  } catch(const std::filesystem::filesystem_error&) { return L"destination-inspection-failed"; }
}
static DWORD WINAPI RunOrbital(void*);
static UINT_PTR __cdecl OrbitalLifetime(int message) {
  // NSPIM_UNLOAD is the last callback; silent NSIS may not send GUIUNLOAD.
  if(message==0 && g_uiThread) {
    // Quit bypasses .onInstFailed (e.g. stock extraction failures). Never
    // silently dismiss an in-flight installation or leave exit code success.
    if(g_window && SendMessageW(g_window,WM_ORBITAL_FALLBACK,0,0)) {
      if(g_execFlags) g_execFlags->errorLevel=2;
    } else if(g_window) SendMessageW(g_window,WM_ORBITAL_STOP,0,0);
    WaitForSingleObject(g_uiThread,INFINITE); CloseHandle(g_uiThread); g_uiThread=nullptr;
    if(g_decisionEvent) { CloseHandle(g_decisionEvent); g_decisionEvent=nullptr; }
  }
  return 0;
}
extern "C" BOOL WINAPI DllMain(HINSTANCE module,DWORD reason,LPVOID) {
  if(reason==DLL_PROCESS_ATTACH) { g_module=module; DisableThreadLibraryCalls(module); }
  return TRUE;
}
#define ORBITAL_EXPORT(name) extern "C" __declspec(dllexport) void __cdecl name(HWND, int size, wchar_t*, NsisStack** stack, NsisExtra* extra)
ORBITAL_EXPORT(Start) {
  g_assets=PopNsis(stack); g_version=PopNsis(stack); g_destination=PopNsis(stack);
  g_installed=PopNsis(stack); g_required=PopNsis(stack);
  auto fail=[&]() { PushNsis(stack,size,L"0"); PushNsis(stack,size,L"0"); PushNsis(stack,size,L""); PushNsis(stack,size,L"error"); };
  if(g_uiThread || !extra || extra->registerCallback(g_module,OrbitalLifetime)<0) { fail(); return; }
  g_execFlags=static_cast<NsisExecFlags*>(extra->execFlags);
  g_backend=true;
  g_decisionEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);
  if(g_decisionEvent) g_uiThread=CreateThread(nullptr,0,RunOrbital,nullptr,0,nullptr);
  if(!g_uiThread) { fail(); return; }
  HANDLE waits[]={g_decisionEvent,g_uiThread};
  const DWORD wait=WaitForMultipleObjects(2,waits,FALSE,INFINITE);
  if(wait!=WAIT_OBJECT_0) g_action=2;
  PushNsis(stack,size,g_shortcuts[1]?L"1":L"0");
  PushNsis(stack,size,g_shortcuts[0]?L"1":L"0");
  PushNsis(stack,size,g_destination);
  PushNsis(stack,size,g_action==1?L"install":g_action==2?L"error":L"cancel");
}
ORBITAL_EXPORT(Validate) {
  const auto path=PopNsis(stack), registered=PopNsis(stack), product=PopNsis(stack);
  PushNsis(stack,size,InstallTargetResult(path,registered,product));
}
ORBITAL_EXPORT(Begin) {
  // Synchronous on the UI thread: cancel/critical transition has one owner.
  const bool proceed=g_window && SendMessageW(g_window,WM_ORBITAL_PHASE,1,reinterpret_cast<LPARAM>(L"NSIS: a instalar e a extrair o payload. Aguarde o fim desta fase."));
  PushNsis(stack,size,proceed?L"ok":L"cancel");
}
// Verify installed bytes against NSIS's freshly extracted embedded payload.
// Existing files from a previous version cannot satisfy this by mere presence.
static bool HashFile(const std::filesystem::path& path, BYTE (&digest)[32]) {
  HANDLE file=CreateFileW(path.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_SEQUENTIAL_SCAN,nullptr);
  if(file==INVALID_HANDLE_VALUE) return false;
  BY_HANDLE_FILE_INFORMATION info{};
  bool ok=GetFileInformationByHandle(file,&info) && !(info.dwFileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY));
  BCRYPT_ALG_HANDLE algorithm=nullptr; BCRYPT_HASH_HANDLE hash=nullptr;
  if(ok) ok=BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)>=0;
  if(ok) ok=BCryptCreateHash(algorithm,&hash,nullptr,0,nullptr,0,0)>=0;
  BYTE buffer[65536]; DWORD count=0;
  while(ok) {
    if(!ReadFile(file,buffer,sizeof(buffer),&count,nullptr)) { ok=false; break; }
    if(count==0) break;
    ok=BCryptHashData(hash,buffer,count,0)>=0;
  }
  if(ok) ok=BCryptFinishHash(hash,digest,sizeof(digest),0)>=0;
  if(hash) BCryptDestroyHash(hash);
  if(algorithm) BCryptCloseAlgorithmProvider(algorithm,0);
  CloseHandle(file); return ok;
}
static bool VerifyPayload(const std::wstring& installed,const std::wstring& source) {
  namespace fs=std::filesystem;
  if(!ValidDestination(installed) || !ValidDestination(source)) return false;
  try {
    size_t verified=0;
    for(const auto& entry:fs::recursive_directory_iterator(source)) {
      const auto rel=fs::relative(entry.path(),source);
      const auto dest=fs::path(installed)/rel;
      const DWORD a=GetFileAttributesW(entry.path().c_str()),b=GetFileAttributesW(dest.c_str());
      if(a==INVALID_FILE_ATTRIBUTES || b==INVALID_FILE_ATTRIBUTES || (a&FILE_ATTRIBUTE_REPARSE_POINT) || (b&FILE_ATTRIBUTE_REPARSE_POINT)) return false;
      if(entry.is_directory()) { if(!(b&FILE_ATTRIBUTE_DIRECTORY)) return false; continue; }
      if(!entry.is_regular_file()) return false;
      BYTE expected[32], actual[32];
      if(!HashFile(entry.path(),expected) || !HashFile(dest,actual) || memcmp(expected,actual,32)!=0) return false;
      ++verified;
    }
    return verified>0;
  } catch(const fs::filesystem_error&) { return false; }
}
ORBITAL_EXPORT(Verify) {
  const auto installed=PopNsis(stack), source=PopNsis(stack);
  PushNsis(stack,size,VerifyPayload(installed,source)?L"ok":L"mismatch");
}
ORBITAL_EXPORT(Phase) {
  const auto text=PopNsis(stack);
  if(g_window) SendMessageW(g_window,WM_ORBITAL_PHASE,0,reinterpret_cast<LPARAM>(text.c_str()));
}
ORBITAL_EXPORT(Finish) {
  const auto status=PopNsis(stack), text=PopNsis(stack);
  const bool offerOpen=status==L"success-open";
  if(g_window) SendMessageW(g_window,WM_ORBITAL_RESULT,offerOpen?2:status==L"success"?1:0,reinterpret_cast<LPARAM>(text.c_str()));
  if(g_uiThread) WaitForSingleObject(g_uiThread,INFINITE);
  if(offerOpen) PushNsis(stack,size,g_openRequested?L"open":L"close");
}
