function e(t){return({dispatch:n,getState:u})=>d=>r=>typeof r=="function"?r(n,u,t):d(r)}var i=e(),f=e;export{i as thunk,f as withExtraArgument};
