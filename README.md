# Student Wallet

Ứng dụng quản lý chi tiêu sinh viên, quỹ nhóm và hoàn tiền có xác nhận on-chain. Giao diện là PWA tĩnh; dữ liệu ứng dụng dùng Supabase và quỹ nhóm dùng hợp đồng trên Avalanche Fuji.

## Cấu hình an toàn

1. Sao chép `config.example.js` thành `config.js`.
2. Điền Supabase Project URL và **Publishable key** vào `config.js`.
3. Không đưa `config.js`, `sb_secret_...`, khóa `service_role`, private key ví hoặc bất kỳ secret nào lên GitHub hay vào frontend.
4. `config.js` nằm trong `.gitignore`; khi triển khai bản tĩnh lên Netlify Drop, cần thêm tệp cấu hình cục bộ vào gói triển khai riêng.

Supabase Publishable key được thiết kế để xuất hiện trong frontend; nó không cấp quyền quản trị. Hãy giữ RLS bật và kiểm tra chính sách truy cập trước khi dùng dữ liệu thật.

## Cài đặt Supabase

1. Trong Supabase SQL Editor chạy `schema.sql`.
2. Chạy `schema_groups_secure.sql` để tạo các bảng nhóm, chính sách RLS, giới hạn sửa và cột blockchain.
3. Đặt Site URL và Redirect URLs trong Authentication > URL Configuration theo địa chỉ Netlify.
4. Chạy app qua máy chủ tĩnh hoặc Netlify, không mở trực tiếp bằng `file://`.

## Blockchain demo

- Mạng: Avalanche Fuji testnet; chỉ dùng AVAX test, không dùng tài sản thật.
- Contract hiện dùng: `StudentGroupVaultV3.sol`.
- Contract Fuji: `0xfcCc67Dd8642640F4b17981aF349b4C092252F21`.
- V3 xác thực nhóm bằng chữ ký ví trưởng nhóm, giới hạn thành viên được phép và chặn hoàn tiền trùng theo expense key.
- Mã demo và các bước trình bày: `UNIHACK_DEMO.md`.

## Bản ứng dụng

Service worker hiện dùng cache `sw-v26`. Bản v26 sửa việc đọc ngày hóa đơn: ưu tiên ngày trên hóa đơn, chấp nhận ngày quá khứ và để trống nếu không đọc được thay vì tự điền ngày hiện tại.

Để triển khai lên Netlify Drop: tạo `config.js` cục bộ từ mẫu, sau đó tải thư mục ứng dụng cùng cấu hình lên Netlify. Không commit cấu hình có URL/Publishable key thật vào repo.
