function c(l,f=1){const o=[],i=Math.floor(f),r=(s,n)=>{for(let t=0;t<s.length;t++){const e=s[t];Array.isArray(e)&&n<i?r(e,n+1):o.push(e)}};return r(l,0),o}export{c as flatten};
