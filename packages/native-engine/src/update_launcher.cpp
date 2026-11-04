// Fixed, non-elevating Windows launcher. No installation logic or shell command.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <vector>
#include <array>
#include "update_launcher_program.h"
#include <wincrypt.h>
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

static int VerifyPreviewSignature(const wchar_t* bytes, const wchar_t* signature) {
  std::vector<uint8_t> message, sig;
  if (!DecodeBase64(bytes, 24000, message) || !DecodeBase64(signature, 88, sig) || sig.size() != 64) return 2;
  return crypto_ed25519_check(sig.data(), kPreviewKey.data(), message.data(), message.size()) == 0 ? 0 : 7;
}

int wmain(int argc, wchar_t** argv) {
  if (argc == 4 && std::wstring(argv[1]) == L"--verify-preview-signature") return VerifyPreviewSignature(argv[2], argv[3]);
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
