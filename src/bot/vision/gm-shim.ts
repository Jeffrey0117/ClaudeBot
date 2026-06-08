/**
 * A JS prelude defining a minimal set of GM_* / GM.* APIs. Privileged ops
 * (download, xhr) call window.<bindingName>(json); a CDP Runtime.addBinding
 * routes that to the runner, which fetches on the Node side (no CORS).
 */
export function buildGmShim(bindingName: string): string {
  const b = JSON.stringify(bindingName)
  return `;(function(){
  var B = function(o){ try { window[${b}](JSON.stringify(o)); } catch(e){} };
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
  window.GM_xmlhttpRequest = function(o){ o=o||{}; B({kind:'xhr', method:o.method||'GET', url:String(o.url||'')}); if(typeof o.onload==='function'){ try{ o.onload({status:200, responseText:'', response:null, readyState:4}); }catch(e){} } return { abort:function(){} }; };
  window.GM = { info: window.GM_info, addStyle: window.GM_addStyle, setClipboard: window.GM_setClipboard, openInTab: window.GM_openInTab, download: window.GM_download, xmlHttpRequest: window.GM_xmlhttpRequest, setValue:function(k,v){window.GM_setValue(k,v);return Promise.resolve();}, getValue:function(k,d){return Promise.resolve(window.GM_getValue(k,d));}, deleteValue:function(k){window.GM_deleteValue(k);return Promise.resolve();} };
})();`
}
