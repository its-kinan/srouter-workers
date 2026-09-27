function x(t,s,c,o=0,u=1){const n=Array.from(t).sort((a,e)=>a.sortNodePosition(e)).indexOf(s),i=t.size,r=(i-1)*o;return typeof c=="function"?c(n,i):u===1?n*o:r-n*o}export{x as calcChildStagger};
