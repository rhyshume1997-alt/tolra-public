/* Colour selector for the document styles.
   Input: ?c=#rrggbb in the URL, or the saved choice in localStorage. Output: sets --c and --on-c on :root.
   --on-c is black or white, whichever reads on top of the chosen colour. Hidden when printing.
   Do not change: the variable names --c and --on-c, which every theme-*.css reads. */
(function(){
  var KEY="tolra-doc-colour", doc=document.documentElement;
  function ok(v){return /^#[0-9a-f]{6}$/i.test(v||"")}
  function on(h){var r=parseInt(h.substr(1,2),16),g=parseInt(h.substr(3,2),16),b=parseInt(h.substr(5,2),16);return (r*299+g*587+b*114)/1000>150?"#111111":"#ffffff"}
  function get(){var q=new URLSearchParams(location.search).get("c");if(q&&ok("#"+q.replace("#","")))return "#"+q.replace("#","");try{var s=localStorage.getItem(KEY);if(ok(s))return s}catch(e){}return null}
  function set(h){
    if(!h){doc.style.removeProperty("--c");doc.style.removeProperty("--on-c");try{localStorage.removeItem(KEY)}catch(e){}return}
    doc.style.setProperty("--c",h);doc.style.setProperty("--on-c",on(h));try{localStorage.setItem(KEY,h)}catch(e){}
    window.dispatchEvent(new CustomEvent("tolra-colour",{detail:h}));
  }
  var start=get();if(start)set(start);
  window.TolraColour={set:set,get:get};
  if(window.top!==window.self)return; /* no panel inside the picker preview frames */
  var p=document.createElement("div");p.className="colour-panel";
  p.innerHTML='<label>Your colour <input type="color" value="'+(start||"#888888")+'"></label><input class="hex" maxlength="7" placeholder="#hex" value="'+(start||"")+'"><button type="button">Reset</button>';
  document.body.appendChild(p);
  var pick=p.querySelector("input[type=color]"),hex=p.querySelector(".hex");
  pick.addEventListener("input",function(){hex.value=pick.value;set(pick.value)});
  hex.addEventListener("input",function(){var v=hex.value.charAt(0)=="#"?hex.value:"#"+hex.value;if(ok(v)){pick.value=v;set(v)}});
  p.querySelector("button").addEventListener("click",function(){set(null);hex.value=""});
})();
