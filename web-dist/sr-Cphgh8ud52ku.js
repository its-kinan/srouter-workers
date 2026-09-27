import{__exports as d}from"./sr-XVEzGEwI4CGP.js";import{__require as O}from"./sr-BbOOC6F9w6pY.js";import{__require as w}from"./sr-P7Q3oFQuEK4B.js";/**
 * @license React
 * use-sync-external-store-shim/with-selector.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */var V;function k(){if(V)return d;V=1;var a=O(),j=w();function q(r,u){return r===u&&(r!==0||1/r===1/u)||r!==r&&u!==u}var z=typeof Object.is=="function"?Object.is:q,M=j.useSyncExternalStore,W=a.useRef,h=a.useEffect,y=a.useMemo,D=a.useDebugValue;return d.useSyncExternalStoreWithSelector=function(r,u,m,v,t){var i=W(null);if(i.current===null){var f={hasValue:!1,value:null};i.current=f}else f=i.current;i=y(function(){function _(e){if(!s){if(s=!0,c=e,e=v(e),t!==void 0&&f.hasValue){var o=f.value;if(t(o,e))return n=o}return n=e}if(o=n,z(c,e))return o;var R=v(e);return t!==void 0&&t(o,R)?(c=e,o):(c=e,n=R)}var s=!1,c,n,b=m===void 0?null:m;return[function(){return _(u())},b===null?void 0:function(){return _(b())}]},[u,m,v,t]);var l=M(r,i[0],i[1]);return h(function(){f.hasValue=!0,f.value=l},[l]),D(l),l},d}export{k as __require};
