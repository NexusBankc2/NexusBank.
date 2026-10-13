import {supabase,money,formatDate,escapeHtml} from '../supabase.js';
import {requireUser,logout,$,nav,toast,accountFor} from './common.js';

$('logoutBtn').onclick=logout;
$('nav').innerHTML=nav('send');

let user,account,recipient;


/* ============================================================
   SAFE STORAGE
   Prevent browser storage quota errors from breaking transfers.
   localStorage is tried first, then sessionStorage.
   If both fail, the transfer continues in memory.
   ============================================================ */

function storageGet(key){
  try{
    const value=localStorage.getItem(key);
    if(value)return value;
  }catch(_e){}

  try{
    const value=sessionStorage.getItem(key);
    if(value)return value;
  }catch(_e){}

  return null;
}

function storageSet(key,value){
  try{
    localStorage.setItem(key,String(value));
    return true;
  }catch(_e){}

  try{
    sessionStorage.setItem(key,String(value));
    return true;
  }catch(_e){}

  return false;
}

function storageRemove(key){
  try{
    localStorage.removeItem(key);
  }catch(_e){}

  try{
    sessionStorage.removeItem(key);
  }catch(_e){}
}


let activeTransferRequestId=
  storageGet('nexus_active_transfer_request_id')||null;

let activeTransferChallengeId=
  storageGet('nexus_active_transfer_challenge_id')||null;

let otpBusy=false;
let lookupTimer;


/* ============================================================
   RECIPIENT
   ============================================================ */

function showRecipient(t){
  $('recipientBox').hidden=false;
  $('recipientBox').className=
    `notice ${t.ok?'notice-ok':'notice-error'}`;

  $('recipientBox').innerHTML=t.html;
}


/* ============================================================
   ACTIVE TRANSFER
   ============================================================ */

function saveActiveTransfer(id){
  activeTransferRequestId=
    id ? String(id) : null;

  if(activeTransferRequestId){
    /*
     * IMPORTANT:
     * Storage failure must never stop the transfer.
     */
    storageSet(
      'nexus_active_transfer_request_id',
      activeTransferRequestId
    );
  }else{
    storageRemove(
      'nexus_active_transfer_request_id'
    );
  }
}

function clearActiveTransfer(){
  activeTransferRequestId=null;
  activeTransferChallengeId=null;

  storageRemove(
    'nexus_active_transfer_request_id'
  );

  storageRemove(
    'nexus_active_transfer_challenge_id'
  );
}


/* ============================================================
   LOAD
   ============================================================ */

async function load(){
  account=await accountFor(user.id);

  if(!account){
    throw Error(
      'No NEXUS account was found.'
    );
  }

  $('currency').textContent=
    account.currency||'USD';

  $('balance').textContent=
    money(
      account.balance,
      account.currency
    );

  if(account.status==='frozen'){
    toast(
      'Transfer unavailable',
      'This account is frozen. You cannot make a transfer at this moment. Kindly contact Customer Care for further information and support.',
      'error',
      {
        href:'#/support',
        support:true
      }
    );
  }

  if(account.status==='pending'){
    toast(
      'Transaction pending',
      'This account is currently pending. New transfers can remain pending until the account is active.',
      'warning',
      {
        href:'#/support',
        support:true
      }
    );
  }

  await restorePendingTransfer();
}


/* ============================================================
   RECIPIENT LOOKUP
   ============================================================ */

async function lookup(){
  clearTimeout(lookupTimer);

  const n=$('recipient').value.trim();

  if(n.length<4){
    $('recipientBox').hidden=true;
    recipient=null;
    return;
  }

  lookupTimer=setTimeout(async()=>{
    const {
      data:r,
      error
    }=await supabase
      .from('recipient_accounts')
      .select(
        'account_number,account_name,bank_name,status'
      )
      .eq('account_number',n)
      .maybeSingle();

    if(error){
      recipient=null;

      showRecipient({
        ok:false,
        html:
          '<strong>Unable to verify account</strong><br>Please try again in a moment.'
      });

      return;
    }

    if(!r||r.status!=='active'){
      recipient=null;

      showRecipient({
        ok:false,
        html:
          '<strong>Account not found</strong><br>Please check the account number and try again.'
      });

      return;
    }

    recipient=r;

    showRecipient({
      ok:true,
      html:
        `<strong>${escapeHtml(r.account_name)}</strong><br>`+
        `${escapeHtml(r.bank_name)}<br>`+
        `Account ${escapeHtml(r.account_number)}`
    });

  },300);
}


/* ============================================================
   REQUEST OTP
   ============================================================ */

async function requestOtp(){

  if(!activeTransferRequestId){
    throw Error(
      'No active transfer request was found.'
    );
  }

  const {
    data:sent,
    error:sendError
  }=await supabase.functions.invoke(
    'nexus-transfer-otp',
    {
      body:{
        transfer_request_id:
          activeTransferRequestId
      }
    }
  );

  if(sendError){
    throw sendError;
  }

  if(!sent?.success){
    throw Error(
      sent?.error||
      sent?.message||
      'The OTP could not be sent.'
    );
  }

  if(!sent?.challenge_id){
    throw Error(
      'The verification challenge was not created.'
    );
  }

  activeTransferChallengeId=
    String(sent.challenge_id);

  /*
   * Do NOT allow storage failure to break OTP.
   */
  storageSet(
    'nexus_active_transfer_challenge_id',
    activeTransferChallengeId
  );

  return sent;
}


/* ============================================================
   OTP MODAL
   ============================================================ */

function openOtpModal(message='', options={}){

  const resendButton=$('resendOtpBtn');
  if(resendButton){
    resendButton.hidden=!Boolean(options.showResend);
    resendButton.disabled=false;
  }

  if(message){
    $('otpMsg').style.display='block';

    $('otpMsg').className=
      'notice notice-error';

    $('otpMsg').textContent=
      message;
  }else{
    $('otpMsg').style.display='none';
    $('otpMsg').textContent='';
  }

  $('otpModal').classList.add('show');

  setTimeout(()=>{
    try{
      $('otp').focus();
    }catch(_e){}
  },50);
}


/* ============================================================
   RESTORE PENDING TRANSFER / OTP CHALLENGE
   ============================================================ */

async function recoverPendingTransferId(){
  if(activeTransferRequestId || !user?.id) return activeTransferRequestId;
  // The browser may discard local storage in some preview contexts. Recover
  // only this signed-in user's newest unexpired OTP-required request.
  const now=new Date().toISOString();
  const {data:req,error}=await supabase
    .from('transfer_requests')
    .select('id,expires_at,created_at')
    .eq('sender_user_id',user.id)
    .in('status',['awaiting_otp','otp_required'])
    .gt('expires_at',now)
    .order('created_at',{ascending:false})
    .limit(1)
    .maybeSingle();
  if(error){
    console.error('[NEXUS Send Money] Could not discover a pending transfer:',JSON.stringify({message:error.message||null,code:error.code||null,details:error.details||null,hint:error.hint||null}));
    return null;
  }
  if(req?.id) saveActiveTransfer(req.id);
  return activeTransferRequestId;
}

async function recoverPendingChallenge(){
  if(!activeTransferRequestId || !user?.id) return null;

  // Prefer the SECURITY DEFINER recovery RPC. It can find the active challenge
  // without requiring the browser client to read protected challenge rows.
  // The RPC returns the challenge UUID for this user's exact pending transfer.
  try{
    const {data:challengeId,error:rpcError}=await supabase.rpc(
      'get_pending_transfer_otp_challenge',
      {p_transfer_id:activeTransferRequestId}
    );

    if(!rpcError && challengeId){
      activeTransferChallengeId=String(challengeId);
      storageSet('nexus_active_transfer_challenge_id',activeTransferChallengeId);
      return {
        id:activeTransferChallengeId,
        transfer_id:activeTransferRequestId,
        user_id:user.id,
        status:'pending'
      };
    }

    if(rpcError){
      console.warn('[NEXUS Send Money] OTP recovery RPC unavailable; trying the user-scoped table lookup:',JSON.stringify({
        message:rpcError.message||null,
        code:rpcError.code||null,
        details:rpcError.details||null,
        hint:rpcError.hint||null
      }));
    }
  }catch(rpcException){
    console.warn('[NEXUS Send Money] OTP recovery RPC threw an error; trying the user-scoped table lookup:',rpcException?.message||rpcException);
  }

  // Fallback for deployments where the RPC schema cache has not refreshed yet.
  // This lookup remains strictly scoped to the signed-in user and this transfer.
  const now=new Date().toISOString();
  let query=supabase
    .from('transfer_otp_challenges')
    .select('id,transfer_id,user_id,expires_at,status,created_at')
    .eq('transfer_id',activeTransferRequestId)
    .eq('user_id',user.id)
    .eq('status','pending')
    .gt('expires_at',now);

  if(activeTransferChallengeId) query=query.eq('id',activeTransferChallengeId);

  let {data:challenge,error}=await query
    .order('created_at',{ascending:false})
    .limit(1)
    .maybeSingle();

  if(error){
    console.error('[NEXUS Send Money] Existing OTP challenge lookup failed:',JSON.stringify({
      message:error.message||null, code:error.code||null,
      details:error.details||null, hint:error.hint||null
    }));
    return null;
  }

  // A stored challenge ID may be stale; try the newest valid challenge for
  // the same transfer and same authenticated user before declaring recovery failed.
  if(!challenge && activeTransferChallengeId){
    const retry=await supabase
      .from('transfer_otp_challenges')
      .select('id,transfer_id,user_id,expires_at,status,created_at')
      .eq('transfer_id',activeTransferRequestId)
      .eq('user_id',user.id)
      .eq('status','pending')
      .gt('expires_at',now)
      .order('created_at',{ascending:false})
      .limit(1)
      .maybeSingle();

    if(retry.error){
      console.error('[NEXUS Send Money] Latest OTP challenge lookup failed:',JSON.stringify({
        message:retry.error.message||null, code:retry.error.code||null,
        details:retry.error.details||null, hint:retry.error.hint||null
      }));
      return null;
    }
    challenge=retry.data;
  }

  if(challenge?.id){
    activeTransferChallengeId=String(challenge.id);
    storageSet('nexus_active_transfer_challenge_id',activeTransferChallengeId);
    return challenge;
  }

  activeTransferChallengeId=null;
  storageRemove('nexus_active_transfer_challenge_id');
  return null;
}

async function restorePendingTransfer(){

  if(!activeTransferRequestId){
    await recoverPendingTransferId();
  }
  if(!activeTransferRequestId){
    return;
  }

  const {
    data:req,
    error
  }=await supabase
    .from('transfer_requests')
    // Use the real row shape rather than naming optional columns that may
    // differ between deployed schema revisions. The query remains scoped to
    // this user's exact request ID.
    .select('*')
    .eq('id',activeTransferRequestId)
    .eq('sender_user_id',user.id)
    .maybeSingle();

  if(error){
    // Emit readable Supabase diagnostics instead of the unhelpful [object Object].
    console.error('[NEXUS Send Money] Pending transfer lookup failed:',JSON.stringify({
      message:error.message||null,
      code:error.code||null,
      details:error.details||null,
      hint:error.hint||null
    }));
    openOtpModal('Your transfer is awaiting verification, but NEXUS could not check it right now. Check your connection and try again.');
    return;
  }
  if(!req){
    // Keep the reference until the server can confirm the request is absent;
    // never treat a transient empty response as permission to start another.
    console.warn('[NEXUS Send Money] Pending transfer was not returned; retaining its recovery reference.');
    return;
  }

  /*
   * These are the states that can still legitimately
   * require OTP verification.
   */
  const validOtpStatuses=[
    'awaiting_otp',
    'otp_required'
  ];

  if(
    !validOtpStatuses.includes(req.status)||
    !req.expires_at||
    new Date(req.expires_at).getTime()<=Date.now()
  ){

    clearActiveTransfer();

    if(validOtpStatuses.includes(req.status)){
      toast(
        'Transfer expired',
        'The previous transfer verification request has expired. Please start the transfer again.',
        'warning'
      );
    }

    return;
  }

  const restoredAccountNumber=String(req.recipient_account_number||'');
  let restoredName=req.recipient_name||'';
  let restoredBank=req.recipient_bank||'';

  // Older transfer rows may not have recipient_bank populated. Recover it from
  // the recipient directory instead of displaying a name without the bank.
  if(restoredAccountNumber && (!restoredName || !restoredBank)){
    const directory=await supabase
      .from('recipient_accounts')
      .select('account_number,account_name,bank_name,status')
      .eq('account_number',restoredAccountNumber)
      .maybeSingle();
    if(directory.error){
      console.warn('[NEXUS Send Money] Recipient detail recovery failed:',JSON.stringify({
        message:directory.error.message||null, code:directory.error.code||null,
        details:directory.error.details||null, hint:directory.error.hint||null
      }));
    }else if(directory.data){
      restoredName=restoredName||directory.data.account_name||'';
      restoredBank=restoredBank||directory.data.bank_name||'';
    }
  }

  recipient={
    account_number:restoredAccountNumber,
    account_name:restoredName,
    bank_name:restoredBank,
    status:'active'
  };

  $('recipient').value=restoredAccountNumber;
  $('amount').value=req.amount;
  $('reference').value=req.reference||'';
  $('currency').textContent=req.currency||account.currency||'USD';

  showRecipient({
    ok:true,
    html:
      `<strong>${escapeHtml(restoredName||'Recipient')}</strong><br>`+
      `${escapeHtml(restoredBank||'Bank details unavailable')}<br>`+
      `Account ${escapeHtml(restoredAccountNumber)}`
  });

  // Never send a fresh email automatically on page reload/resume. Recover the
  // existing challenge; if it cannot be found, expose an explicit resend action.
  const challenge=await recoverPendingChallenge();
  if(!challenge){
    openOtpModal(
      'Your transfer is still awaiting verification, but NEXUS could not recover the existing code challenge. Use Resend Code only if you need a new email code.',
      {showResend:true}
    );
    return;
  }

  openOtpModal(
    'Your transfer is still awaiting OTP verification. Enter the code already sent to your registered email.'
  );
}


/* ============================================================
   RECIPIENT INPUT
   ============================================================ */

$('recipient').addEventListener(
  'input',
  lookup
);


/* ============================================================
   SEND MONEY FORM
   ============================================================ */

$('form').onsubmit=e=>{
  e.preventDefault();

  if(activeTransferRequestId){
    return openOtpModal(
      'You already have a transfer awaiting OTP verification.'
    );
  }

  if(!recipient){
    return toast(
      'Recipient required',
      'Enter a valid account number and wait for the recipient details to appear.',
      'error'
    );
  }

  const amount=
    Number($('amount').value);

  if(!amount||amount<=0){
    return toast(
      'Invalid amount',
      'Enter a valid transfer amount.',
      'error'
    );
  }

  if(
    amount>
    Number(account.balance||0)
  ){
    return toast(
      'Insufficient balance',
      'The transfer amount is greater than your available balance.',
      'error'
    );
  }

  if(account.status==='frozen'){
    return toast(
      'Transfer unavailable',
      'This account is frozen. You cannot make a transfer at this moment. Kindly contact Customer Care.',
      'error',
      {
        href:'#/support',
        support:true
      }
    );
  }

  $('pinModal').classList.add('show');
  $('pin').focus();
};


/* ============================================================
   CANCEL PIN
   ============================================================ */

$('cancelPin').onclick=()=>{
  $('pinModal').classList.remove('show');
  $('pin').value='';
};


/* ============================================================
   PIN -> CREATE TRANSFER -> SEND OTP
   ============================================================ */

$('confirmBtn').onclick=async()=>{

  const pin=
    $('pin').value.trim();

  if(!/^\d{4,6}$/.test(pin)){
    return toast(
      'PIN required',
      'Enter your 4–6 digit transaction PIN.',
      'error'
    );
  }

  $('confirmBtn').disabled=true;

  try{

    /*
     * STEP 1
     * Verify transaction PIN.
     */

    const {
      data:pinResult,
      error:pinError
    }=await supabase.rpc(
      'verify_transaction_pin',
      {
        p_pin:pin
      }
    );

    if(pinError){
      throw pinError;
    }

    if(!pinResult?.success){

      if(pinResult?.locked){
        throw Error(
          pinResult.message||
          'Transaction PIN is temporarily locked.'
        );
      }

      throw Error(
        pinResult?.message||
        'Incorrect transaction PIN.'
      );
    }


    /*
     * STEP 2
     * Create the transfer request.
     *
     * CURRENT LIVE SIGNATURE:
     *
     * p_sender_account_id
     * p_recipient_account_number
     * p_amount
     * p_currency
     * p_note
     */

    const {
      data:transferResult,
      error:transferError
    }=await supabase.rpc(
      'create_transfer_request',
      {
        p_sender_account_id:
          account.id,

        p_recipient_account_number:
          recipient.account_number,

        p_amount:
          Number($('amount').value),

        p_currency:
          account.currency||'USD',

        p_note:
          $('reference').value.trim()||
          null
      }
    );

    if(transferError){
      throw transferError;
    }

    if(!transferResult?.success){
      throw Error(
        transferResult?.message||
        'Transfer request could not be created.'
      );
    }

    /*
     * Accept the normal transfer_id returned by
     * the current database function.
     */
    const transferId=
      transferResult.transfer_id||
      transferResult.transfer_request_id||
      transferResult.id;

    if(!transferId){
      throw Error(
        'The transfer request was created but no transfer ID was returned.'
      );
    }

    saveActiveTransfer(transferId);

    $('pinModal').classList.remove('show');
    $('otp').value='';


    /*
     * STEP 3
     *
     * IMPORTANT:
     * The OTP modal is NOT shown before this succeeds.
     */

    try{

      await requestOtp();

      /*
       * ONLY after the OTP function successfully
       * returns a challenge ID do we show this message.
       */
      openOtpModal(
        'A 6-digit verification code has been sent to your registered email.'
      );

    }catch(emailError){

      /*
       * OTP request did not return a confirmed success response.
       *
       * Do NOT cancel or clear the transfer here. The Edge Function may
       * have created the challenge or sent the email before the client
       * received an error response. Keeping the request ID allows the
       * customer to recover the existing challenge or explicitly resend.
       * No funds are moved by this step; execution still requires OTP
       * verification through verify_transfer_otp_and_execute.
       */

      const otpErrorMessage=String(
        emailError?.message||
        emailError?.error||
        'The verification request could not be confirmed.'
      );

      console.error(
        '[NEXUS Send Money] OTP request failed; keeping transfer recoverable:',
        JSON.stringify({
          message:otpErrorMessage,
          status:emailError?.status||emailError?.context?.status||null,
          code:emailError?.code||null
        })
      );

      openOtpModal(
        'NEXUS could not confirm the verification request. Your transfer has been kept open and has not been sent. If you received a code, try it first. Otherwise use Resend Code to request a new code.',
        {showResend:true}
      );

      return;
    }

  }catch(e){

    $('pinModal').classList.remove('show');

    const m=
      e.message||
      'Transfer request failed';

    if(/frozen/i.test(m)){

      toast(
        'Transfer unavailable',
        'This account is frozen. You cannot make a transfer at this moment. Kindly contact Customer Care for further information and support.',
        'error',
        {
          href:'#/support',
          support:true
        }
      );

    }else if(/pending/i.test(m)){

      toast(
        'Transaction pending',
        'Your transaction is pending because this account is currently pending.',
        'warning',
        {
          href:'#/support',
          support:true
        }
      );

    }else if(
      /incorrect transaction pin/i.test(m)
    ){

      toast(
        'Incorrect PIN',
        'The transaction PIN you entered is incorrect.',
        'error'
      );

    }else if(
      /temporarily locked/i.test(m)
    ){

      toast(
        'PIN temporarily locked',
        m,
        'error'
      );

    }else{

      toast(
        'Transfer failed',
        m,
        'error'
      );
    }

  }finally{

    $('confirmBtn').disabled=false;
  }
};


/* ============================================================
   EXPLICIT RESEND OTP
   Reloading/restoring the page must never send a new code automatically.
   ============================================================ */

const resendOtpButton=$('resendOtpBtn');
if(resendOtpButton){
  resendOtpButton.hidden=true;
  resendOtpButton.onclick=async()=>{
    if(!activeTransferRequestId || otpBusy || !user?.id) return;
    resendOtpButton.disabled=true;
    try{
      const {data:req,error}=await supabase
        .from('transfer_requests')
        .select('id,status,expires_at')
        .eq('id',activeTransferRequestId)
        .eq('sender_user_id',user.id)
        .maybeSingle();
      if(error) throw error;
      if(!req || !['awaiting_otp','otp_required'].includes(req.status) || !req.expires_at || new Date(req.expires_at).getTime()<=Date.now()){
        throw Error('This transfer verification has expired. Please start a new transfer.');
      }
      activeTransferChallengeId=null;
      storageRemove('nexus_active_transfer_challenge_id');
      await requestOtp();
      $('otp').value='';
      openOtpModal('A new 6-digit code has been sent. Use the newest email code only.');
      toast('Verification code sent','Check your registered email and enter the newest code.','success');
    }catch(e){
      openOtpModal(e.message||'NEXUS could not resend the verification code. Please try again.',{showResend:true});
    }finally{
      resendOtpButton.disabled=false;
    }
  };
}


/* ============================================================
   CANCEL OTP
   ============================================================ */

$('cancelOtp').onclick=async()=>{

  if(!activeTransferRequestId){
    $('otpModal').classList.remove('show');
    return;
  }

  try{

    await supabase.rpc(
      'cancel_transfer_request',
      {
        p_transfer_id:
          activeTransferRequestId
      }
    );

  }catch(_e){}

  clearActiveTransfer();

  $('otpModal').classList.remove('show');

  $('otp').value='';
};


/* ============================================================
   VERIFY OTP + EXECUTE TRANSFER
   ============================================================ */

$('verifyOtpBtn').onclick=async()=>{

  if(!activeTransferRequestId){
    return toast(
      'Transfer unavailable',
      'There is no active transfer awaiting verification.',
      'error'
    );
  }

  const otp=
    $('otp').value.trim();

  if(!/^\d{6}$/.test(otp)){

    $('otpMsg').style.display='block';

    $('otpMsg').className=
      'notice notice-error';

    $('otpMsg').textContent=
      'Enter the 6-digit OTP code.';

    return;
  }

  if(otpBusy)return;

  otpBusy=true;

  $('verifyOtpBtn').disabled=true;

  $('otpMsg').style.display='none';

  try{

    /*
     * A browser reload can leave the transfer ID intact while the in-memory
     * challenge ID is missing. Recover the existing challenge before hiding
     * the OTP modal or attempting verification. Never discard the transfer
     * merely because the challenge lookup temporarily fails.
     */
    if(!activeTransferChallengeId){
      const recoveredChallenge=await recoverPendingChallenge();

      if(!recoveredChallenge){
        openOtpModal(
          'NEXUS could not recover the existing verification challenge. Your transfer has not been sent. Check your connection or use Resend Code to request a new code.',
          {showResend:true}
        );
        return;
      }
    }

    $('otpModal').classList.remove('show');
    $('processModal').classList.add('show');

    /*
     * STEP 4
     * Verify OTP and execute the transfer.
     */

    const {
      data,
      error
    }=await supabase.rpc(
      'verify_transfer_otp_and_execute',
      {
        p_challenge_id:
          activeTransferChallengeId,

        p_code:
          otp
      }
    );

    if(error){
      throw error;
    }

    if(!data?.success){
      throw Error(
        data?.message||
        'OTP verification failed.'
      );
    }

    const t=
      data.transaction;

    if(!t){
      throw Error(
        'The transfer was completed but no transaction receipt was returned.'
      );
    }

    const pending=
      t.status==='pending';

    $('processModal').classList.remove('show');

    $('receipt').innerHTML=`
      <div class="receipt">

        <div style="text-align:center">

          <div class="status-pill ${pending?'pending':''}">
            ${pending?'Pending':'Sent Successfully'}
          </div>

          <h2>NEXUS Transaction Receipt</h2>

        </div>

        <div class="receipt-row">
          <span>Recipient</span>
          <strong>${escapeHtml(
            recipient.account_name
          )}</strong>
        </div>

        <div class="receipt-row">
          <span>Bank</span>
          <strong>${escapeHtml(
            recipient.bank_name
          )}</strong>
        </div>

        <div class="receipt-row">
          <span>Account</span>
          <strong>${escapeHtml(
            recipient.account_number
          )}</strong>
        </div>

        <div class="receipt-row">
          <span>Amount</span>
          <strong>${money(
            t.amount,
            t.currency
          )}</strong>
        </div>

        <div class="receipt-row">
          <span>Status</span>
          <strong>${escapeHtml(
            t.status
          )}</strong>
        </div>

        <div class="receipt-row">
          <span>Reference</span>
          <strong>${escapeHtml(
            t.reference||t.id
          )}</strong>
        </div>

        <div class="receipt-row">
          <span>Date</span>
          <strong>${formatDate(
            t.display_transaction_at||
            t.created_at
          )}</strong>
        </div>

      </div>
    `;

    $('receiptModal').classList.add('show');

    /*
     * Clear active transfer only after successful execution.
     */
    clearActiveTransfer();

    $('amount').value='';
    $('reference').value='';
    $('pin').value='';
    $('otp').value='';

    await load();

  }catch(e){

    $('processModal').classList.remove('show');

    const m=
      e.message||
      'OTP verification failed';

    /*
     * Keep the active transfer when the OTP itself is
     * incorrect or expired so the customer can try again.
     */
    if(
      /expired/i.test(m)||
      /OTP/i.test(m)||
      /verification code/i.test(m)||
      /incorrect/i.test(m)||
      /challenge/i.test(m)
    ){

      // Keep the original transfer recoverable on challenge-related errors.
      // A resend is explicit; returning from Gmail never sends a new code.
      openOtpModal(m,{showResend:/expired|incorrect|verification challenge|challenge|OTP/i.test(m)});

    }else{

      clearActiveTransfer();

      toast(
        'Transfer failed',
        m,
        'error'
      );
    }

  }finally{

    otpBusy=false;

    $('verifyOtpBtn').disabled=false;
  }
};


/* ============================================================
   CLOSE RECEIPT
   ============================================================ */

$('closeReceipt').onclick=()=>{
  $('receiptModal').classList.remove('show');
};


/* ============================================================
   AUTHENTICATED USER
   ============================================================ */

requireUser(async(u)=>{

  user=u;

  try{

    await load();

  }catch(e){

    toast(
      'Unable to load Send Money',
      e.message||
      'Please try again.',
      'error'
    );
  }

});