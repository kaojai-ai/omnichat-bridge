// Shopee TH New Webchat protocol observed from its native video sender.
// Upload grants are request-local and never leave this browser process.
(() => {
  function md5(buffer) {
    const bytes = new Uint8Array(buffer);
    const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
    padded.set(bytes); padded[bytes.length] = 128;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, (bytes.length * 8) >>> 0, true);
    view.setUint32(padded.length - 4, Math.floor(bytes.length / 0x20000000), true);
    const shifts = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
    let state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    for (let offset = 0; offset < padded.length; offset += 64) {
      let [a,b,c,d] = state;
      for (let i = 0; i < 64; i++) {
        const group = i >> 4;
        const f = group === 0 ? (b & c) | (~b & d) : group === 1 ? (d & b) | (~d & c)
          : group === 2 ? b ^ c ^ d : c ^ (b | ~d);
        const g = group === 0 ? i : group === 1 ? (5*i+1)%16 : group === 2 ? (3*i+5)%16 : (7*i)%16;
        const sum = (a + f + (Math.floor(Math.abs(Math.sin(i+1))*0x100000000) >>> 0) + view.getUint32(offset+g*4,true)) | 0;
        const shift = shifts[group*4+i%4];
        const next = (b + ((sum << shift) | (sum >>> (32-shift)))) | 0;
        a=d; d=c; c=b; b=next;
      }
      state = state.map((v,i) => (v+[a,b,c,d][i]) | 0);
    }
    return state.map(v => [0,8,16,24].map(n => ((v>>>n)&255).toString(16).padStart(2,'0')).join('')).join('');
  }

  // Native MMS v2 wraps upload grants with a public client-side protocol key.
  // Decrypt locally; the short-lived result is used only by this upload request.
  async function uploadToken(encoded) {
    try {
      if (typeof encoded !== "string" || !encoded || encoded.length > 4096) throw new Error();
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("shopee_vod_00120"),
        { name: "AES-CBC" }, false, ["decrypt"]);
      const ciphertext = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      const plaintext = await crypto.subtle.decrypt({ name: "AES-CBC",
        iv: new TextEncoder().encode("1234567887654321") }, key, ciphertext);
      const token = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      if (!token || /[\r\n\0]/.test(token)) throw new Error();
      return token;
    } catch {
      throw new Error("Shopee video upload grant is invalid.");
    }
  }

  async function upload({ bytes, type, deadline, fetch, chatRequest }) {
    if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > 5*1024*1024
      || type !== "video/mp4") throw new Error("Shopee video must be an MP4 file of 5 MB or smaller.");
    const remaining = () => {
      const ms = Math.min(20_000, deadline-Date.now());
      if (ms <= 0) throw new Error("Reply deadline expired during video upload.");
      return ms;
    };
    const request = async (url, init) => {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(remaining()) });
      if (!response.ok) throw new Error(`Shopee video upload returned ${response.status}.`);
      const body = await response.json();
      if (body?.code && body.code !== 0) throw new Error("Shopee video upload was rejected.");
      return body;
    };
    const json = (body) => ({ method:"POST", credentials:"omit", headers:{"content-type":"application/json"}, body:JSON.stringify(body) });
    const reportdata = () => ({sdkversion:"mms-3.5.15",appversion:"mms-3.5.15",ostype:"2",reporttime:Date.now()});
    const initial = await request("https://api.mms.shopee.sg/uploadapi/api/v1/vod/preupload", json({biz:120,ver:2,mediatype:1,reportdata:reportdata()}));
    const grant = initial?.data;
    const service = grant?.services?.find(item => item.serviceid === "wscloud");
    if (!/^sg-[a-zA-Z0-9-]+$/.test(grant?.vid ?? "") || !service?.token
      || service.uploaddomain !== "https://up-ws-sg.vod.susercontent.com"
      || service.domain !== "https://down-ws-global.vod.susercontent.com") {
      throw new Error("Shopee video upload service is unsupported.");
    }
    const token = await uploadToken(service.token);
    const key = `${grant.vid}.ori.mp4`;
    const form = new FormData();
    form.append("file",new Blob([bytes],{type}),key);
    form.append("token",token); form.append("key",key); form.append("mimeType",type);
    const uploaded = await fetch(`${service.uploaddomain}/file/upload`, {
      method:"POST", credentials:"omit", body:form, signal:AbortSignal.timeout(remaining()),
    });
    if (!uploaded.ok) throw new Error(`Shopee video transfer returned ${uploaded.status}.`);
    const digest = md5(bytes);
    const videoUrl = `${service.domain}/${key}`;
    await request("https://api.mms.shopee.sg/uploadapi/api/v1/vod/reportupload",json({
      vid:grant.vid,mid:"",serviceid:service.serviceid,biz:120,code:0,extendid:grant.vid,
      fileinfos:{mediatype:1},fsize:bytes.byteLength,md5:digest,reportdata:reportdata(),
      updomain:service.uploaddomain,videourl:videoUrl,
    }));
    const register = await chatRequest("report_upload", {
      method:"POST",body:JSON.stringify({extend_id:grant.vid,file_size:bytes.byteLength,md5:digest,vid:grant.vid,video_url:videoUrl}),
      signal:AbortSignal.timeout(remaining()),
    });
    if (!register.ok) throw new Error("Shopee video registration failed.");
    while (true) {
      const response = await chatRequest("upload_status",{method:"GET",vid:grant.vid,signal:AbortSignal.timeout(remaining())});
      const status = await response.json();
      if (!response.ok) throw new Error("Shopee video processing check failed.");
      if (status.status === "successful") {
        if (!status.video || !status.thumbnail || !(status.width>0) || !(status.height>0) || !(status.duration>0)) {
          throw new Error("Shopee processed video metadata is incomplete.");
        }
        return {vid:grant.vid,video_url:status.video,thumb_url:status.thumbnail,
          thumb_width:status.width,thumb_height:status.height,duration_seconds:status.duration/1000};
      }
      if (["failed","error"].includes(status.status)) throw new Error("Shopee video processing failed.");
      await new Promise(resolve => setTimeout(resolve,Math.min(500,remaining())));
    }
  }
  globalThis.OmnichatShopeeVideo = {upload,md5};
})();
