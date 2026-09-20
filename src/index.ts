export type Match={start:number;end:number};
export function normalizeText(value:string){return value.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase()}
export function findMatches(text:string,query:string):Match[]{const haystack=normalizeText(text);const needle=normalizeText(query);const out:Match[]=[];let at=0;while(needle&&((at=haystack.indexOf(needle,at))>=0)){out.push({start:at,end:at+needle.length});at+=Math.max(1,needle.length)}return out}
