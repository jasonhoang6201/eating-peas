# Static server cho lúc phát triển: giống `python3 -m http.server`, thêm header Cache-Control: no-store
# để trình duyệt luôn tải file JS mới nhất. Không có header này, trình duyệt có thể giữ bản cũ của một
# module (ví dụ human.js) trong khi đã tải bản mới của module import nó (scene.js), và trang dừng với lỗi import.
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
http.server.ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
