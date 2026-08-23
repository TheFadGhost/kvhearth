# fish completion for kvhearth-cli

complete -c kvhearth-cli -l host -d 'server address' -r
complete -c kvhearth-cli -l port -d 'server port' -r
complete -c kvhearth-cli -l theme -d 'colour theme' -r -a 'dark light plain'
complete -c kvhearth-cli -l no-color -d 'disable colours'
complete -c kvhearth-cli -l eval -d 'run one command and exit' -r
complete -c kvhearth-cli -l version -d 'print version'
complete -c kvhearth-cli -l help -d 'show help'

set -l commands APPEND AUTH BGSAVE CONFIG DEBUG DEL ECHO EXEC EXISTS EXPIRE EXPIREAT FLUSHALL FLUSHDB GET GETRANGE HDEL HEXISTS HGET HGETALL HINCRBY HKEYS HLEN HSET HVALS INCR INCRBY INFO LASTSAVE LINDEX LLEN LPUSH LRANGE LSET LTRIM MEMORY MONITOR MULTI PERSIST PING PSUBSCRIBE PUBLISH PUNSUBSCRIBE RESET REWRITEAOF RENAME RENAMENX RPUSH SAVE SCAN SADD SET SETRANGE SINTER SINTERSTORE SISMEMBER SMEMBERS SLOWLOG SUNION SUNIONSTORE SDIFF SDIFFSTORE SUBSCRIBE STRLEN SHUTDOWN TYPE UNSUBSCRIBE UNWATCH WATCH ZADD ZCARD ZCOUNT ZINCRBY ZRANGE ZRANGEBYSCORE ZRANK ZREM ZREVRANGEBYSCORE ZREVRANK ZSCORE QUIT

complete -c kvhearth-cli -a "$commands"
