var e=a=>a.replace(/([A-Z])/g,c=>"-".concat(c.toLowerCase())),n=(a,c,o)=>a.map(t=>"".concat(e(t)," ").concat(c,"ms ").concat(o)).join(",");export{e as getDashCase,n as getTransitionVal};
