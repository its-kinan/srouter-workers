const t=/^(?:oklch|oklab|lab|lch|color|color-mix|light-dark)\(/;function l(r){for(let o=0;o<r.length;o++)if(typeof r[o]=="string"&&t.test(r[o]))return!0;return!1}export{l as hasBrowserOnlyColors};
