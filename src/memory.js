'use strict';

// Query + read only.
const koffi = require('koffi');
const kernel32 = koffi.load('kernel32.dll');
const ACCESS = 0x0400 | 0x0010; // PROCESS_QUERY_INFORMATION | PROCESS_VM_READ
const READABLE = new Set([0x02, 0x04, 0x08, 0x20, 0x40, 0x80]);
const MEMORY_BASIC_INFORMATION = koffi.struct('MEMORY_BASIC_INFORMATION', {
  BaseAddress: 'uint64', AllocationBase: 'uint64', AllocationProtect: 'uint32',
  __alignment1: 'uint32', RegionSize: 'uint64', State: 'uint32', Protect: 'uint32',
  Type: 'uint32', __alignment2: 'uint32',
});
const OpenProcess = kernel32.func('void* __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void* handle)');
const GetExitCodeProcess = kernel32.func('bool __stdcall GetExitCodeProcess(void* process, _Out_ uint32* code)');
const VirtualQueryEx = kernel32.func('size_t __stdcall VirtualQueryEx(void* process, uint64 address, _Out_ MEMORY_BASIC_INFORMATION* info, size_t length)');
const ReadProcessMemory = kernel32.func('bool __stdcall ReadProcessMemory(void* process, uint64 address, _Out_ void* buffer, size_t size, _Out_ size_t* read)');
const PROCESSENTRY32W = koffi.struct('PROCESSENTRY32W', {
  dwSize: 'uint32', cntUsage: 'uint32', th32ProcessID: 'uint32',
  th32DefaultHeapID: 'uintptr', th32ModuleID: 'uint32', cntThreads: 'uint32',
  th32ParentProcessID: 'uint32', pcPriClassBase: 'int32', dwFlags: 'uint32',
  szExeFile: koffi.array('uint16', 260),
});
const CreateToolhelp32Snapshot = kernel32.func('void* __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)');
const Process32FirstW = kernel32.func('bool __stdcall Process32FirstW(void* snapshot, _Inout_ PROCESSENTRY32W* entry)');
const Process32NextW = kernel32.func('bool __stdcall Process32NextW(void* snapshot, _Inout_ PROCESSENTRY32W* entry)');

function findPid() {
  const snapshot = CreateToolhelp32Snapshot(0x02, 0);
  if (!snapshot || koffi.address(snapshot) === 0xffffffffffffffffn) throw new Error('Could not enumerate running processes');
  try {
    const entry = { dwSize: koffi.sizeof(PROCESSENTRY32W) };
    let found = Process32FirstW(snapshot, entry);
    while (found) {
      const name = String.fromCharCode(...entry.szExeFile).split('\0')[0];
      if (name.toLowerCase() === 'warframe.x64.exe') return entry.th32ProcessID;
      found = Process32NextW(snapshot, entry);
    }
    return null;
  } finally { CloseHandle(snapshot); }
}

class Client {
  constructor(pid) {
    this.pid = pid;
    this.handle = OpenProcess(ACCESS, false, pid);
    if (!this.handle) throw new Error(`Could not read Warframe (pid ${pid}); check that both apps run as the same user.`);
  }
  close() {
    if (this.handle) CloseHandle(this.handle);
    this.handle = null;
  }
  isAlive() {
    const code = [0];
    return Boolean(this.handle && GetExitCodeProcess(this.handle, code) && code[0] === 259);
  }
  // Legacy callers still read whole regions.
  *regions(maxRegion = 256 * 1024 * 1024) {
    const info = {};
    let address = 0n;
    while (address < 0x7fffffffffffn) {
      if (!VirtualQueryEx(this.handle, address, info, koffi.sizeof(MEMORY_BASIC_INFORMATION))) break;
      const base = BigInt(info.BaseAddress), size = BigInt(info.RegionSize);
      if (size === 0n || base + size <= address) break;
      if (info.State === 0x1000 && READABLE.has(info.Protect & 0xff) &&
          !(info.Protect & 0x100) && (maxRegion === Infinity || size <= BigInt(maxRegion))) {
        yield { base, size: Number(size), type: info.Type };
      }
      address = base + size;
    }
  }
  read(address, size) {
    const buffer = Buffer.allocUnsafe(size), read = [0];
    ReadProcessMemory(this.handle, address, buffer, size, read);
    // ERROR_PARTIAL_COPY can return valid bytes. Never expose its unread tail.
    if (!read[0]) return null;
    return buffer.subarray(0, Number(read[0]));
  }
}

module.exports = { Client, findPid };
