var i=(d,n)=>{if(!(d==null||n==null)){var e=d.find(u=>u.stackId===n.stackId&&n.dataKey!=null&&u.dataKeys.includes(n.dataKey));if(e!=null)return e.position}};export{i as combineBarPosition};
