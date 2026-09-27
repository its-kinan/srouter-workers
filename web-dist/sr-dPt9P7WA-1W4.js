function s(f,{style:y,vars:n},r,t){const l=f.style;let e;for(e in y)l[e]=y[e];t==null||t.applyProjectionStyles(l,r);for(e in n)l.setProperty(e,n[e])}export{s as renderHTML};
