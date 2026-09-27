import{__exports as d}from"./sr-LDixhT4uW9Qt.js";import{__require as D}from"./sr-BbOOC6F9w6pY.js";/**
 * @license React
 * use-sync-external-store-with-selector.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */var y;function q(){if(y)return d;y=1;var f=D();function V(r,u){return r===u&&(r!==0||1/r===1/u)||r!==r&&u!==u}var E=typeof Object.is=="function"?Object.is:V,S=f.useSyncExternalStore,W=f.useRef,j=f.useEffect,z=f.useMemo,M=f.useDebugValue;return d.useSyncExternalStoreWithSelector=function(r,u,v,m,n){var o=W(null);if(o.current===null){var t={hasValue:!1,value:null};o.current=t}else t=o.current;o=z(function(){function s(e){if(!_){if(_=!0,l=e,e=m(e),n!==void 0&&t.hasValue){var i=t.value;if(n(i,e))return c=i}return c=e}if(i=c,E(l,e))return i;var R=m(e);return n!==void 0&&n(i,R)?(l=e,i):(l=e,c=R)}var _=!1,l,c,b=v===void 0?null:v;return[function(){return s(u())},b===null?void 0:function(){return s(b())}]},[u,v,m,n]);var a=S(r,o[0],o[1]);return j(function(){t.hasValue=!0,t.value=a},[a]),M(a),a},d}export{q as __require};
