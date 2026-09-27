import{__exports as i}from"./sr-BR3J8rqUriYU.js";import{__require as h}from"./sr-BbOOC6F9w6pY.js";/**
 * @license React
 * use-sync-external-store-shim.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */var s;function x(){if(s)return i;s=1;var u=h();function f(e,t){return e===t&&(e!==0||1/e===1/t)||e!==e&&t!==t}var S=typeof Object.is=="function"?Object.is:f,d=u.useState,l=u.useEffect,p=u.useLayoutEffect,E=u.useDebugValue;function v(e,t){var r=t(),a=d({inst:{value:r,getSnapshot:t}}),n=a[0].inst,c=a[1];return p(function(){n.value=r,n.getSnapshot=t,o(n)&&c({inst:n})},[e,r,t]),l(function(){return o(n)&&c({inst:n}),e(function(){o(n)&&c({inst:n})})},[e]),E(r),r}function o(e){var t=e.getSnapshot;e=e.value;try{var r=t();return!S(e,r)}catch{return!0}}function y(e,t){return t()}var m=typeof window>"u"||typeof window.document>"u"||typeof window.document.createElement>"u"?y:v;return i.useSyncExternalStore=u.useSyncExternalStore!==void 0?u.useSyncExternalStore:m,i}export{x as __require};
