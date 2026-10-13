import 'dotenv/config';
import pg from 'pg';
const email=String(process.argv[2]||'').trim().toLowerCase();
if(!email||!/^\S+@\S+\.\S+$/.test(email)){console.error('Usage: npm run admin:bootstrap -- owner@example.com');process.exit(2)}
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:false}:undefined});
try{
  const {rows}=await pool.query(`select u.id,u.email,u.email_verified_at,p.account_status from app_users u join user_profiles p on p.id=u.id where u.email=$1`,[email]);
  if(!rows[0]||!rows[0].email_verified_at){console.error('The account must exist and have a verified email first.');process.exitCode=1;}
  else{
    await pool.query(`insert into platform_admins(user_id,role,status) values($1,'super_admin','active') on conflict(user_id) do update set role='super_admin',status='active',updated_at=now()`,[rows[0].id]);
    await pool.query(`insert into platform_audit_log(actor_id,action,entity_type,entity_id,details) values($1,'bootstrap_super_admin','platform_admin',$1,$2)`,[rows[0].id,JSON.stringify({email})]);
    console.log(`Super Admin access assigned to verified account ${email}. Configure and complete MFA at first sign-in.`);
  }
}finally{await pool.end()}
