/**
 * A JS prelude defining a minimal set of GM_* / GM.* APIs. Privileged ops
 * (download, xhr) push a record onto the global capture array (named by
 * `arrayName`); the runner reads that array once at the end (no CDP binding —
 * more robust than Runtime.addBinding, which has context-timing footguns).
 */
export function buildGmShim(bindingName: string): string {
  const b = JSON.stringify(bindingName)
  return `;(function(){
  var B = function(o){ try { (window[${b}] = window[${b}] || []).push(o); } catch(e){} };
  window.GM_info = { script: { name: 'cb', version: '1.0' }, scriptHandler: 'ClaudeBot' };
  window.unsafeWindow = window;
  window.GM_addStyle = function(css){ var s=document.createElement('style'); s.textContent=css; (document.head||document.documentElement).appendChild(s); return s; };
  window.GM_setValue = function(k,v){ try{ localStorage.setItem('__gm_'+k, JSON.stringify(v)); }catch(e){} };
  window.GM_getValue = function(k,d){ try{ var x=localStorage.getItem('__gm_'+k); return x==null?d:JSON.parse(x); }catch(e){ return d; } };
  window.GM_deleteValue = function(k){ try{ localStorage.removeItem('__gm_'+k); }catch(e){} };
  window.GM_listValues = function(){ var r=[]; for(var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); if(k&&k.indexOf('__gm_')===0) r.push(k.slice(5)); } return r; };
  window.GM_setClipboard = function(t){ try{ navigator.clipboard.writeText(String(t)); }catch(e){} };
  window.GM_openInTab = function(u){ try{ return window.open(u,'_blank'); }catch(e){} };
  window.GM_registerMenuCommand = function(){ return 0; };
  window.GM_unregisterMenuCommand = function(){};
  window.GM_download = function(a, name){ var url=(a&&a.url)||a; var n=(a&&a.name)||name||''; B({kind:'download', url:String(url), name:String(n)}); };
  var _xid = 0; window.__cbXhr = window.__cbXhr || {};
  window.GM_xmlhttpRequest = function(o){
    o = o || {}; var id = ++_xid; window.__cbXhr[id] = o;
    B({kind:'xhr', id:id, method:o.method||'GET', url:String(o.url||''), headers:o.headers||{}, data:(o.data!=null?String(o.data):null), responseType:o.responseType||'text'});
    return { abort:function(){ delete window.__cbXhr[id]; } };
  };
  window.__cbXhrResolve = function(id, resp){
    var o = window.__cbXhr[id]; if(!o) return; delete window.__cbXhr[id];
    try {
      if (resp && resp.error){ if(o.onerror) o.onerror({error:resp.error}); return; }
      var r = { readyState:4, status:resp.status, statusText:resp.statusText||'', responseText:resp.responseText||'', responseHeaders:resp.responseHeaders||'', finalUrl:resp.finalUrl||o.url, response:null };
      if (resp.base64 != null){ var bin=atob(resp.base64); var arr=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i); r.response = (o.responseType==='blob')?new Blob([arr]):arr.buffer; }
      else { r.response = resp.responseText||''; }
      if (o.onload) o.onload(r);
    } catch(e){ if(o.onerror) o.onerror({error:String(e)}); }
  };
  window.GM_getResourceText = function(n){ try{ return (window.__cbRes||{})[n]; }catch(e){ return undefined; } };
  window.GM_getResourceURL = function(n){ return n; };
  window.GM_notification = function(){};
  window.GM = { info: window.GM_info, addStyle: window.GM_addStyle, setClipboard: window.GM_setClipboard, openInTab: window.GM_openInTab, download: window.GM_download, xmlHttpRequest: window.GM_xmlhttpRequest, setValue:function(k,v){window.GM_setValue(k,v);return Promise.resolve();}, getValue:function(k,d){return Promise.resolve(window.GM_getValue(k,d));}, deleteValue:function(k){window.GM_deleteValue(k);return Promise.resolve();}, getResourceText: window.GM_getResourceText, notification: window.GM_notification };
})();`
}

/**
 * Captures NATIVE downloads — the common `<a download>` path scripts use via
 * fetch+blob (NOT GM_download). Hooks anchor clicks, reads the file in-page
 * (works for blob:/data: URLs that the Node side can't reach), and sends it as
 * base64 via the binding ({kind:'filedata'}). Falls back to sending the URL for
 * Node-side fetch ({kind:'download'}) when in-page read fails (e.g. http+CORS).
 */
export function buildDownloadShim(bindingName: string): string {
  const b = JSON.stringify(bindingName)
  return `;(function(){
  var B = function(o){ try { (window[${b}] = window[${b}] || []).push(o); } catch(e){} };
  var seen = {};
  function cap(href, name){
    if (!href || seen[href]) return;
    seen[href] = 1;
    try {
      fetch(href).then(function(r){ return r.blob(); }).then(function(blob){
        var fr = new FileReader();
        fr.onload = function(){ B({kind:'filedata', name: name || 'download', dataUrl: String(fr.result)}); };
        fr.onerror = function(){ B({kind:'download', url: href, name: name || ''}); };
        fr.readAsDataURL(blob);
      }).catch(function(){ B({kind:'download', url: href, name: name || ''}); });
    } catch(e){ B({kind:'download', url: href, name: name || ''}); }
  }
  try {
    var _click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function(){
      try {
        if (this.hasAttribute('download') && this.href) {
          cap(this.href, this.getAttribute('download'));
          return; // suppress the native download (we captured it) — no Chrome dialog
        }
      } catch(e){}
      return _click.apply(this, arguments);
    };
  } catch(e){}
  document.addEventListener('click', function(e){
    try {
      var a = (e.target && e.target.closest) ? e.target.closest('a[download]') : null;
      if (a && a.href) { cap(a.href, a.getAttribute('download')); e.preventDefault(); }
    } catch(err){}
  }, true);
})();`
}
