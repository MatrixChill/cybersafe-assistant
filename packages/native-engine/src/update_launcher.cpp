// Fixed, non-elevating Windows launcher. No installation logic or shell command.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <vector>
#include <array>
#include "update_launcher_program.h"

int wmain(int argc, wchar_t** argv) {
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
  WaitForSingleObject(process.hProcess, INFINITE);
  CloseHandle(process.hProcess);
  return 0;
}
