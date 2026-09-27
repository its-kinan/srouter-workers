function r(t){if(!t)return null;for(const e of t.elements){const n=e.tagName;if(n==="BUTTON"||n==="INPUT"){const u=e;if(u.type==="submit")return u}}return null}export{r as getDefaultFormSubmitter};
