# bash completion for kvhearth-cli
_kvhearth_cli() {
  local cur prev commands
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_WORDS[CURLWORD]-1]}"
  prev="${COMP_WORDS[COMP_WORDS[CURLWORD]-1]}"
  commands="APPEND AUTH BGSAVE CONFIG DEBUG DEL ECHO EXEC EXISTS EXPIRE EXPIREAT FLUSHALL FLUSHDB GET GETRANGE HDEL HEXISTS HGET HGETALL HINCRBY HKEYS HLEN HSET HVALS INCR INCRBY INFO LASTSAVE LINDEX LLEN LPUSH LRANGE LSET LTRIM MEMORY MONITOR MULTI PERSIST PING PSUBSCRIBE PUBLISH PUNSUBSCRIBE RESET REWRITEAOF RENAME RENAMENX RESET RESTORE RPUSH SAVE SCAN SADD SET SETRANGE SINTER SINTERSTORE SISMEMBER SMEMBERS SLOWLOG SUNION SUNIONSTORE SDIFF SDIFFSTORE SUBSCRIBE STRLEN SHUTDOWN TYPE UNLINK UNSUBSCRIBE UNWATCH WATCH ZADD ZCARD ZCOUNT ZINCRBY ZRANGE ZRANGEBYSCORE ZRANK ZREM ZREVRANGEBYSCORE ZREVRANK ZSCORE QUIT"
  case "$prev" in
    kvhearth-cli)
      COMPREPLY=( $(compgen -W "--host --port --theme --no-color --eval --version --help $commands" -- "$cur") )
      return 0
      ;;
    --theme)
      COMPREPLY=( $(compgen -W "dark light plain" -- "$cur") )
      return 0
      ;;
    CONFIG)
      COMPREPLY=( $(compgen -W "GET SET" -- "$cur") )
      return 0
      ;;
    CLIENT)
      COMPREPLY=( $(compgen -W "ID GETNAME SETNAME LIST KILL" -- "$cur") )
      return 0
      ;;
    SLOWLOG)
      COMPREPLY=( $(compgen -W "GET LEN RESET" -- "$cur") )
      return 0
      ;;
    PUBSUB)
      COMPREPLY=( $(compgen -W "CHANNELS NUMSUB NUMPAT" -- "$cur") )
      return 0
      ;;
    INFO)
      COMPREPLY=( $(compgen -W "server clients memory stats keyspace persistence eviction" -- "$cur") )
      return 0
      ;;
  esac
  COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
  return 0
}
complete -F _kvhearth_cli kvhearth-cli
complete -o default -F _kvhearth_cli node
