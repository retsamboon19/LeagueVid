import { execFile } from 'child_process'
import { join } from 'path'
import type { AudioOutputDevice } from '../../shared/types'

// Core Audio endpoint IDs are the IDs WASAPI/OBS consume. Chromium's hashed
// device IDs and DirectShow capture names cannot identify a playback endpoint.
// Enumerate active render endpoints without opening OBS or changing Windows.
const ENUMERATE_OUTPUTS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace LeagueVidAudio {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class Enumerator {}
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IEnumerator {
        void EnumAudioEndpoints(int flow, uint state, out ICollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IDevice device);
    }
    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ICollection {
        void GetCount(out uint count);
        void Item(uint index, out IDevice device);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDevice {
        void Activate(ref Guid iid, uint context, IntPtr parameters, out IntPtr result);
        void OpenPropertyStore(uint access, out IProperties properties);
        void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetState(out uint state);
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey { public Guid format; public uint id; }
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct Variant {
        [FieldOffset(0)] public ushort type;
        [FieldOffset(8)] public IntPtr pointer;
    }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IProperties {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out Variant value);
    }
    public class Output {
        public string id;
        public string name;
        public bool isDefault;
    }
    public static class Devices {
        [DllImport("ole32.dll")] static extern int PropVariantClear(ref Variant value);
        public static Output[] List() {
            var enumerator = (IEnumerator)new Enumerator();
            ICollection devices = null;
            try {
                string defaultId = null;
                IDevice defaultDevice;
                // eRender, eConsole: the same default used by OBS loopback.
                if (enumerator.GetDefaultAudioEndpoint(0, 0, out defaultDevice) == 0) {
                    try { defaultDevice.GetId(out defaultId); }
                    finally { Marshal.ReleaseComObject(defaultDevice); }
                }
                enumerator.EnumAudioEndpoints(0, 1, out devices);
                uint count;
                devices.GetCount(out count);
                var result = new List<Output>();
                for (uint i = 0; i < count; i++) {
                    IDevice device;
                    devices.Item(i, out device);
                    IProperties properties = null;
                    try {
                        string id;
                        device.GetId(out id);
                        device.OpenPropertyStore(0, out properties);
                        var key = new PropertyKey {
                            format = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), id = 14
                        };
                        Variant value;
                        properties.GetValue(ref key, out value);
                        try {
                            string name = value.type == 31 ? Marshal.PtrToStringUni(value.pointer) : id;
                            result.Add(new Output { id = id, name = name, isDefault = id == defaultId });
                        } finally { PropVariantClear(ref value); }
                    } finally {
                        if (properties != null) Marshal.ReleaseComObject(properties);
                        Marshal.ReleaseComObject(device);
                    }
                }
                return result.ToArray();
            } finally {
                if (devices != null) Marshal.ReleaseComObject(devices);
                Marshal.ReleaseComObject(enumerator);
            }
        }
    }
}
'@
ConvertTo-Json -InputObject @([LeagueVidAudio.Devices]::List()) -Compress
`

export function parseOutputDevices(json: string): AudioOutputDevice[] {
  const parsed: unknown = JSON.parse(json.replace(/^\uFEFF/, '').trim())
  if (!Array.isArray(parsed)) throw new Error('Invalid Windows audio device list.')
  return parsed.filter((device): device is AudioOutputDevice =>
    !!device && typeof device === 'object' &&
    typeof device.id === 'string' && device.id.startsWith('{0.0.0.') &&
    typeof device.name === 'string' && device.name.length > 0 &&
    typeof device.isDefault === 'boolean'
  )
}

export async function listOutputDevices(): Promise<AudioOutputDevice[]> {
  if (process.platform !== 'win32') return []
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const output = await new Promise<string>((resolve, reject) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(ENUMERATE_OUTPUTS, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
    (error, stdout) => {
      if (error) reject(new Error('Could not read Windows output devices. Try refreshing the list.'))
      else resolve(stdout)
    })
  })
  return parseOutputDevices(output)
}
