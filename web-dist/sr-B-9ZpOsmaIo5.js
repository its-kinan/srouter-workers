const i=2e4;function u(e,a=50,n=2e4,o){let t=0,r=e.next(t);for(;!r.done&&t<n;)t+=a,r=e.next(t);return t>=n?1/0:t}export{u as calcGeneratorDuration,i as maxGeneratorDuration};
