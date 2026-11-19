import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { realpath, stat } from "node:fs/promises";
// IFileDialog with FOS_PICKFOLDERS opens the current Windows Explorer-style picker.
// Paths travel through an environment variable, never through executable script text.
export const WINDOWS_FOLDER_PICKER = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Gmm {
 [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] class FileOpenDialog {}
 [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IShellItem {
  void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
  void GetParent(out IShellItem parent);
  void GetDisplayName(uint sigdn, out IntPtr name);
  void GetAttributes(uint mask, out uint attributes);
  void Compare(IShellItem item, uint hint, out int order);
 }
 [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IFileDialog {
  [PreserveSig] int Show(IntPtr owner);
  void SetFileTypes(uint count, IntPtr filters);
  void SetFileTypeIndex(uint index);
  void GetFileTypeIndex(out uint index);
  void Advise(IntPtr events, out uint cookie);
  void Unadvise(uint cookie);
  void SetOptions(uint options);
  void GetOptions(out uint options);
  void SetDefaultFolder(IShellItem folder);
  void SetFolder(IShellItem folder);
  void GetFolder(out IShellItem folder);
  void GetCurrentSelection(out IShellItem selection);
  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
  void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
  void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
  void GetResult(out IShellItem result);
 }
 public static class FolderPicker {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public static string Choose(string initial) {
   IFileDialog dialog = (IFileDialog)new FileOpenDialog();
   try {
    uint flags; dialog.GetOptions(out flags);
    dialog.SetOptions(flags | 0x20u | 0x40u | 0x800u | 0x8u | 0x02000000u);
    dialog.SetTitle("选择项目文件夹"); dialog.SetOkButtonLabel("选择文件夹");
    if (!String.IsNullOrEmpty(initial)) {
     IShellItem folder; Guid iid = typeof(IShellItem).GUID;
     SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out folder);
     try { dialog.SetFolder(folder); } finally { Marshal.ReleaseComObject(folder); }
    }
    int result = dialog.Show(GetForegroundWindow());
    if (result == unchecked((int)0x800704C7)) return null;
    Marshal.ThrowExceptionForHR(result);
    IShellItem selected; dialog.GetResult(out selected);
    try {
     IntPtr path; selected.GetDisplayName(0x80058000u, out path);
     try { return Marshal.PtrToStringUni(path); } finally { Marshal.FreeCoTaskMem(path); }
    } finally { Marshal.ReleaseComObject(selected); }
   } finally { Marshal.ReleaseComObject(dialog); }
  }
 }
}
'@
$selected = [Gmm.FolderPicker]::Choose($env:GMM_PICKER_START)
if ($null -eq $selected) { [Console]::WriteLine('null') }
else { [Console]::WriteLine((ConvertTo-Json -InputObject $selected -Compress)) }
`;
const execute = promisify(execFile);
export async function chooseLocalFolder(initialDirectory = "", run = execute, platform = process.platform) {
    let initial = homedir();
    if (initialDirectory.trim()) {
        if (!isAbsolute(initialDirectory.trim()))
            throw new Error("请输入完整的文件夹路径。");
        try {
            const candidate = await realpath(initialDirectory.trim());
            if ((await stat(candidate)).isDirectory())
                initial = candidate;
        }
        catch { /* A removed last-used folder should not prevent opening the picker. */ }
    }
    const env = {};
    for (const key of Object.keys(process.env))
        if (/^(path|systemroot|windir|temp|tmp|appdata|localappdata|userprofile|home|display|wayland_display|xdg_runtime_dir|dbus_session_bus_address|lang|lc_all)$/i.test(key))
            env[key] = process.env[key];
    env.GMM_PICKER_START = initial;
    const options = { env, windowsHide: true, timeout: 600_000, maxBuffer: 64 * 1024, encoding: "utf8" };
    let selected;
    try {
        if (platform === "win32") {
            const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(WINDOWS_FOLDER_PICKER, "utf16le").toString("base64")], options);
            selected = JSON.parse(stdout.trim().replace(/^\uFEFF/, ""));
        }
        else if (platform === "darwin") {
            const { stdout } = await run("osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose project folder" default location (POSIX file (system attribute "GMM_PICKER_START")))'], options);
            selected = stdout.trim();
        }
        else {
            const { stdout } = await run("zenity", ["--file-selection", "--directory", "--title=Choose project folder", `--filename=${initial}/`], options);
            selected = stdout.trim();
        }
    }
    catch (error) {
        const failure = error;
        if ((platform === "darwin" && /\(-128\)/.test(failure.stderr ?? "")) || (platform !== "win32" && platform !== "darwin" && Number(failure.code) === 1))
            return { canceled: true };
        throw new Error(failure.killed ? "文件夹选择已超时，请重新点击添加。" : "无法打开系统文件夹选择窗口，请确认 DSH 正在本机桌面环境运行。", { cause: error });
    }
    if (!selected)
        return { canceled: true };
    if (typeof selected !== "string" || !isAbsolute(selected))
        throw new Error("系统返回的文件夹路径无效。");
    const directory = await realpath(selected);
    if (!(await stat(directory)).isDirectory())
        throw new Error("请选择一个文件夹。");
    return { canceled: false, directory };
}
let picking = false;
export async function pickImageFolder(initialDirectory = "") {
    if (picking)
        throw new Error("文件夹选择窗口已打开，请先完成当前选择。");
    picking = true;
    try {
        return await chooseLocalFolder(initialDirectory);
    }
    finally {
        picking = false;
    }
}
/** Reveal only a validated local directory; callers resolve it from an existing project. */
export async function revealLocalFolder(directory, launch = spawn, platform = process.platform) {
    if (!isAbsolute(directory))
        throw new Error("请输入完整的文件夹路径。");
    const target = await realpath(directory);
    if (!(await stat(target)).isDirectory())
        throw new Error("文件夹已不存在。");
    const command = platform === "win32" ? "explorer.exe" : platform === "darwin" ? "open" : "xdg-open";
    await new Promise((resolve, reject) => {
        // Explorer is the requested visible result, rather than a background helper.
        // SW_HIDE can suppress the new folder window even though the process spawns.
        const child = launch(command, [target], { detached: true, stdio: "ignore", windowsHide: platform !== "win32" });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(); });
    });
    return { ok: true, dir: target };
}
