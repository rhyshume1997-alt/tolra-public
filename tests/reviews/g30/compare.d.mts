export type Snapshot={format_version:number;table:string;read_only:boolean;total:number;counts:Record<string,number>;rows:{id:string;organization_id:string;row_sha256:string}[]};
export function compareSnapshots(before:Snapshot,after:Snapshot,options:{jnr:string;disposition:string;expectedJnrBefore?:number}):{
 ok:boolean;baseline_count_ok:boolean;totals:{before:number;after:number};company_counts:{organization_id:string;before:number;after:number;expected_after:number;ok:boolean}[];
 difference_count:number;differences:{kind:string;id:string;expected:boolean;before_company?:string;after_company?:string}[];
};
