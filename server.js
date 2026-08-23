require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname,"public")));

const PORT = process.env.PORT || 3000;
const MP_BASE = "https://api.mercadopago.com";
const SOCKETSYNC_BASE = "https://passes.socketsync.cloud";
const PRICE = "10.00";
const DB_FILE = path.join(__dirname,"data","orders.json");

function loadOrders(){
  try{return JSON.parse(fs.readFileSync(DB_FILE,"utf8"))}
  catch{return []}
}
function saveOrders(orders){
  const tmp=DB_FILE+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(orders,null,2));
  fs.renameSync(tmp,DB_FILE);
}
function id(){return crypto.randomUUID()}
function env(name){
  if(!process.env[name]) throw new Error("Variável de ambiente ausente: "+name);
  return process.env[name];
}
async function mpFetch(url, options={}){
  const token=env("MP_ACCESS_TOKEN");
  const r=await fetch(MP_BASE+url,{
    ...options,
    headers:{
      "Authorization":"Bearer "+token,
      "Content-Type":"application/json",
      ...(options.headers||{})
    }
  });
  const text=await r.text();
  let data={};
  try{data=JSON.parse(text)}catch{data={raw:text}}
  if(!r.ok){
    const err=new Error(data.message || data.error || "Erro Mercado Pago");
    err.status=r.status; err.details=data;
    throw err;
  }
  return data;
}

function parseSignature(header){
  const out={};
  for(const piece of String(header||"").split(",")){
    const [k,...rest]=piece.split("=");
    if(k && rest.length) out[k.trim()]=rest.join("=").trim();
  }
  return out;
}
function validWebhook(req){
  const secret=process.env.MP_WEBHOOK_SECRET;
  if(!secret) return false;

  const xSignature=req.get("x-signature");
  const xRequestId=req.get("x-request-id");
  const dataId=req.query["data.id"] || "";
  if(!xSignature || !xRequestId || !dataId) return false;

  const p=parseSignature(xSignature);
  if(!p.ts || !p.v1) return false;

  const manifest=`id:${dataId};request-id:${xRequestId};ts:${p.ts};`;
  const expected=crypto.createHmac("sha256",secret).update(manifest).digest("hex");

  try{
    return crypto.timingSafeEqual(
      Buffer.from(expected,"hex"),
      Buffer.from(p.v1,"hex")
    );
  }catch{return false}
}

function findOrder(localId){
  return loadOrders().find(o=>o.id===localId);
}
function updateOrder(localId, patch){
  const orders=loadOrders();
  const i=orders.findIndex(o=>o.id===localId);
  if(i<0) return null;
  orders[i]={...orders[i],...patch,updatedAt:new Date().toISOString()};
  saveOrders(orders);
  return orders[i];
}

async function deliver(order){
  if(order.deliveryStatus==="delivered") return order;

  updateOrder(order.id,{status:"paid",deliveryStatus:"sending"});

  const response=await fetch(SOCKETSYNC_BASE+"/api/v1/pass",{
    method:"POST",
    headers:{
      "Authorization":"Bearer "+env("SOCKETSYNC_API_KEY"),
      "Content-Type":"application/json"
    },
    body:JSON.stringify({player_id:order.playerId})
  });

  const text=await response.text();
  let body;
  try{body=JSON.parse(text)}catch{body=text}

  if(!response.ok){
    updateOrder(order.id,{
      status:"delivery_failed",
      deliveryStatus:"failed",
      deliveryHttpStatus:response.status,
      deliveryResponse:body
    });
    throw new Error("SocketSync recusou a entrega.");
  }

  // A API fornecida pelo usuário usa POST /api/v1/pass.
  // Como o formato exato da resposta não foi fornecido, HTTP 2xx
  // é tratado como aceitação da entrega e a resposta é registrada.
  return updateOrder(order.id,{
    status:"delivered",
    deliveryStatus:"delivered",
    deliveredAt:new Date().toISOString(),
    deliveryHttpStatus:response.status,
    deliveryResponse:body
  });
}

async function verifyAndDeliverByMpOrder(mpOrderId){
  const mpOrder=await mpFetch("/v1/orders/"+encodeURIComponent(mpOrderId));
  const localId=mpOrder.external_reference;
  const order=findOrder(localId);
  if(!order) return {ignored:true,reason:"pedido local não encontrado"};

  if(mpOrder.status==="processed" || mpOrder.status==="accredited"){
    if(order.deliveryStatus!=="delivered"){
      await deliver(order);
    }
  }else if(mpOrder.status==="failed"){
    updateOrder(order.id,{status:"failed",deliveryStatus:"not_sent"});
  }else if(mpOrder.status==="canceled" || mpOrder.status==="expired"){
    updateOrder(order.id,{status:"cancelled",deliveryStatus:"not_sent"});
  }else{
    updateOrder(order.id,{status:"pending"});
  }

  return findOrder(order.id);
}

app.post("/api/orders",async(req,res)=>{
  try{
    const {playerId,email}=req.body||{};
    if(!/^\d{5,15}$/.test(String(playerId||""))){
      return res.status(400).json({error:"ID de jogador inválido."});
    }
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email||""))){
      return res.status(400).json({error:"E-mail inválido."});
    }

    const localId=id();
    const body={
      type:"online",
      processing_mode:"automatic",
      external_reference:localId,
      total_amount:PRICE,
      description:"Passe Booyah - Ravena Store",
      payer:{email:String(email).trim()},
      transactions:{
        payments:[{
          amount:PRICE,
          payment_method:{id:"pix",type:"bank_transfer"},
          expiration_time:"PT30M"
        }]
      }
    };

    const mpOrder=await mpFetch("/v1/orders",{
      method:"POST",
      headers:{"X-Idempotency-Key":localId},
      body:JSON.stringify(body)
    });

    const payment=mpOrder?.transactions?.payments?.[0];
    const method=payment?.payment_method||{};

    const local={
      id:localId,
      mpOrderId:mpOrder.id,
      playerId:String(playerId),
      email:String(email).trim(),
      amount:PRICE,
      status:mpOrder.status==="processed"?"paid":"pending",
      deliveryStatus:"not_sent",
      createdAt:new Date().toISOString()
    };
    loadOrders().push(local);
    saveOrders(loadOrders());

    // Normalmente Pix começa aguardando transferência.
    // Se o Mercado Pago já devolver processado, entrega imediatamente.
    if(mpOrder.status==="processed"){
      await deliver(local);
    }

    return res.json({
      orderId:localId,
      status:findOrder(localId).status,
      qrCode:method.qr_code || null,
      qrCodeBase64:method.qr_code_base64 || null,
      ticketUrl:method.ticket_url || null
    });
  }catch(e){
    console.error(e);
    res.status(e.status||500).json({
      error:e.message||"Não foi possível criar o pagamento.",
      details:process.env.NODE_ENV==="development"?e.details:undefined
    });
  }
});

app.get("/api/orders/:id",(req,res)=>{
  const o=findOrder(req.params.id);
  if(!o) return res.status(404).json({error:"Pedido não encontrado."});
  res.json({
    orderId:o.id,
    status:o.status,
    deliveryStatus:o.deliveryStatus,
    playerId:o.playerId
  });
});

app.post("/webhooks/mercadopago",async(req,res)=>{
  // O Mercado Pago recomenda validar a assinatura do Webhook.
  if(!validWebhook(req)) return res.sendStatus(401);

  // Responda rapidamente e processe depois.
  res.sendStatus(200);

  try{
    const type=req.query.type || req.body?.type;
    const dataId=req.query["data.id"] || req.body?.data?.id;
    if(type!=="order" || !dataId) return;
    await verifyAndDeliverByMpOrder(String(dataId));
  }catch(e){
    console.error("Erro no webhook:",e);
  }
});

app.get("/health",(req,res)=>res.json({ok:true}));

app.listen(PORT,()=>console.log(`Ravena Store rodando na porta ${PORT}`));
