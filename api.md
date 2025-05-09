

# 关闭浏览器
- GET  /api/v1/browser/stop
- 接口描述：用于关闭对应的浏览器，需要指定环境ID。
- 请求参数
    - user_id：环境ID，创建环境成功后生成的唯一ID。
- 返回数据
```
//执行成功
{
  "code":0,
  "msg":"success"
}

//执行失败
{
  "code":-1,
  "msg":"failed"
}
```        

# 查询环境
- GET  /api/v1/browser/list
- 接口描述：查询已创建的环境信息，包含代理信息、代理ID等。
- 返回数据
```

//执行成功
{
  "code": 0,
  "data": ['aaa', 'bbb'],
  "msg": "Success"
}
        
//执行失败
{
  "code":-1,
  "data":{},
  "msg":"failed"
}


```  