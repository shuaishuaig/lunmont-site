/* Shared runtime for themes: hero feature image + theme persistence.
   Loaded by index.html and themes-preview.html. Zero dependency. */
(function () {
  function firstProduct() {
    var cats = window.PRODUCTS || [];
    for (var i = 0; i < cats.length; i++) {
      var gs = cats[i].groups || [];
      for (var j = 0; j < gs.length; j++) {
        var it = (gs[j].items || [])[0];
        if (it && gs[j].path) return { src: gs[j].path + it.sku + ".jpg", sku: it.sku, name: it.name };
      }
    }
    return null;
  }
  function applyHero() {
    var f = document.querySelector(".hero-feature img");
    if (!f) return;
    var p = firstProduct();
    if (p) {
      f.src = p.src;
      f.alt = p.sku;
      var cap = document.querySelector(".hero-feature figcaption");
      if (cap) cap.textContent = p.sku;
      document.documentElement.classList.add("has-hero");
    }
  }
  function currentTheme() {
    var l = document.getElementById("site-theme");
    return (l && l.getAttribute("href") || "themes/classic.css").replace(/^.*\//, "").replace(/\.css.*$/, "");
  }
  // expose for the studio + preview switcher
  window.SITE_THEME = {
    list: ["classic", "editorial", "noir", "blush", "atelier", "jade"],
    get: currentTheme,
    set: function (id) {
      var l = document.getElementById("site-theme");
      if (!l) return;
      l.href = "themes/" + id + ".css";
      document.documentElement.setAttribute("data-theme", id);
      try { localStorage.setItem("site_theme", id); } catch (e) {}
    }
  };
  function boot() {
    var saved;
    try { saved = new URLSearchParams(location.search).get("theme"); } catch (e) {}
    if (!saved || window.SITE_THEME.list.indexOf(saved) < 0) {
      try { saved = localStorage.getItem("site_theme"); } catch (e) { saved = null; }
    }
    if (saved && window.SITE_THEME.list.indexOf(saved) >= 0) {
      var l = document.getElementById("site-theme");
      if (l) { l.href = "themes/" + saved + ".css"; document.documentElement.setAttribute("data-theme", saved); }
    } else {
      document.documentElement.setAttribute("data-theme", currentTheme());
    }
    applyHero();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
