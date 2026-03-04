const express = require("express")
const http = require("http")
const { Server } = require("socket.io")

const app = express()
const server = http.createServer(app)
const io = new Server(server)

app.use(express.json())
app.use(express.static(__dirname))

let users = []
let messages = []

// регистрация
app.post("/register",(req,res)=>{
  const {username,password}=req.body

  if(users.find(u=>u.username===username))
    return res.json({error:"user exists"})

  const user={id:Date.now(),username,password}
  users.push(user)

  res.json(user)
})

// вход
app.post("/login",(req,res)=>{
  const {username,password}=req.body

  const user=users.find(u=>u.username===username && u.password===password)

  if(!user) return res.json({error:"wrong login"})

  res.json(user)
})

// поиск пользователей
app.get("/users",(req,res)=>{
  res.json(users)
})

io.on("connection",socket=>{

  socket.on("message",msg=>{
    messages.push(msg)
    io.emit("message",msg)
  })

})
server.listen(3000,()=>console.log("server started"))
