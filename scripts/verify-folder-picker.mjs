/** Native folder-picker contract: fake process responses and local paths only; never opens a window. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {EventEmitter} from 'node:events';
import {chooseLocalFolder,revealLocalFolder,WINDOWS_FOLDER_PICKER} from '../lib/folderpicker.js';
import {METHODS} from '../lib/wire.js';
const testRoot=await mkdtemp(join(tmpdir(),'gmm-folder-picker-'));let checks=0;
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('✓ '+label);};
try{
 const directory=join(testRoot,'中文 $ folder');await mkdir(directory);const canonical=await realpath(directory);const requests=[];
 const fake=async(command,args,options)=>{requests.push({command,args,options});return {stdout:JSON.stringify(canonical)};};
 const selected=await chooseLocalFolder(directory,fake,'win32');
 check('Windows picker returns canonical folder',selected.directory===canonical&&!selected.canceled);
 const call=requests[0],script=Buffer.from(call.args.at(-1),'base64').toString('utf16le');
 check('Windows uses Explorer-style native IFileDialog in hidden STA PowerShell',call.command==='powershell.exe'&&call.args.includes('-STA')&&call.args.includes('Hidden')&&call.options.windowsHide&&script===WINDOWS_FOLDER_PICKER&&script.includes('0x20u'));
 check('folder path is data, never executable PowerShell',call.options.env.GMM_PICKER_START===canonical&&!script.includes(canonical));
 check('helper does not receive model credentials',!Object.keys(call.options.env).some(k=>/api.?key|token|secret/i.test(k)));
 check('system cancellation leaves the project uncreated',(await chooseLocalFolder(directory,async()=>({stdout:'null'}),'win32')).canceled);
 await assert.rejects(chooseLocalFolder('relative',fake,'win32'),/完整/);
 await assert.rejects(chooseLocalFolder(directory,async()=>({stdout:'"relative"'}),'win32'),/无效/);
 await assert.rejects(chooseLocalFolder(directory,async()=>{throw Error('missing powershell');},'win32'),/无法打开/);
 const missing=await chooseLocalFolder(join(directory,'removed'),fake,'win32');check('removed prior location does not prevent opening picker',missing.directory===canonical);
 const macCancel=await chooseLocalFolder(directory,async()=>{throw Object.assign(Error('cancel'),{stderr:'User canceled. (-128)'});},'darwin');
 const linuxCancel=await chooseLocalFolder(directory,async()=>{throw Object.assign(Error('cancel'),{code:1});},'linux');check('macOS and Linux cancellations are harmless',macCancel.canceled&&linuxCancel.canceled);
 const schema=METHODS.find(m=>m.method==='pickImageFolder');assert.deepEqual(schema.payload.parse({path:directory}),{path:directory});check('native picker is wired for clients only',schema.clientOnly&&!METHODS.some(m=>m.method==='browseImageFolders'));
 const revealCalls=[];let unreferenced=false;
 const launch=(command,args,options)=>{revealCalls.push({command,args,options});const child=new EventEmitter();child.unref=()=>{unreferenced=true;};queueMicrotask(()=>child.emit('spawn'));return child;};
 const revealed=await revealLocalFolder(directory,launch,'win32');
 check('revealing a folder uses canonical path as one visible Explorer argument',revealed.dir===canonical&&revealCalls[0].command==='explorer.exe'&&revealCalls[0].args.length===1&&revealCalls[0].args[0]===canonical&&revealCalls[0].options.windowsHide===false&&unreferenced);
 await assert.rejects(revealLocalFolder('relative',launch,'win32'),/完整/);
 await assert.rejects(revealLocalFolder(join(testRoot,'missing'),launch,'win32'));
 await assert.rejects(revealLocalFolder(directory,()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('error',Error('synthetic spawn failure')));return child;},'win32'),/synthetic/);
 const revealSchema=METHODS.find(m=>m.method==='revealImageFolder');
 check('folder reveal accepts an explicit directory and is not exposed to model tools',revealSchema.clientOnly&&JSON.stringify(revealSchema.payload.parse({jobId:'itest123',path:canonical}))===JSON.stringify({jobId:'itest123',path:canonical}));
 console.log(`Passed ${checks} folder-picker checks. No UI windows, network or real billing.`);
}finally{const target=resolve(testRoot);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('gmm-folder-picker-'));await rm(target,{recursive:true,force:true});}
