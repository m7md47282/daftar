import { Component, OnInit, inject, input, signal } from '@angular/core';
import { Api } from '../core/api';
import { Ui } from '../core/ui';
import { Auth } from '../core/auth';
import { Lookups } from '../core/lookups';
import { Tabs } from '../shell/tabs';

// الفروع والمستودعات، مراكز التكلفة، المناديب
@Component({
  selector: 'structure-form',
  styles: [`.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
    .box { background: var(--panel); border: 1px solid var(--line); border-radius: 3px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .box h3 { margin: 0; font-size: 15px; } .add { display: flex; gap: 6px; }`],
  template: `
  <div class="win"><div class="win-body">
    @if (!auth.isOwner()) { <div class="banner info">عرض فقط — التعديل متاح للمالك.</div> }
    <div class="cols">
      <div class="box"><h3>الفروع</h3>
        <table class="grid"><tbody>@for (b of lk.branches(); track b.id) { <tr><td class="num">{{ b.id }}</td><td>{{ b.name }}</td></tr> }</tbody></table>
        @if (auth.isOwner()) { <div class="add"><input class="inp" placeholder="اسم الفرع الجديد" #nb /><button class="btn sm primary" (click)="add('branches', {name: nb.value}); nb.value=''">إضافة</button></div>
          <span class="muted">يُنشأ للفرع مستودع وصندوق نقدية تلقائياً.</span> }
      </div>
      <div class="box"><h3>المستودعات</h3>
        <table class="grid"><tbody>@for (w of lk.warehouses(); track w.id) { <tr><td>{{ w.name }}</td><td class="muted">{{ lk.branchName(w.branch_id) }}</td></tr> }</tbody></table>
        @if (auth.isOwner()) { <div class="add"><input class="inp" placeholder="اسم المستودع" #nw />
          <select class="inp" #wb style="width:140px">@for (b of lk.branches(); track b.id) { <option [value]="b.id">{{ b.name }}</option> }</select>
          <button class="btn sm primary" (click)="add('warehouses', {name: nw.value, branch_id: +wb.value}); nw.value=''">إضافة</button></div> }
      </div>
      <div class="box"><h3>مراكز التكلفة</h3>
        <table class="grid"><tbody>@for (c of lk.costCenters(); track c.id) { <tr><td>{{ c.name }}</td></tr> }</tbody></table>
        @if (auth.isOwner()) { <div class="add"><input class="inp" placeholder="اسم مركز التكلفة" #nc /><button class="btn sm primary" (click)="add('cost-centers', {name: nc.value}); nc.value=''">إضافة</button></div> }
      </div>
      <div class="box"><h3>المناديب</h3>
        <table class="grid"><tbody>@for (r of lk.reps(); track r.id) { <tr><td>{{ r.name }}</td><td class="muted">{{ lk.branchName(r.branch_id) }}</td></tr> }</tbody></table>
        @if (auth.isOwner()) { <div class="add"><input class="inp" placeholder="اسم المندوب" #nr />
          <select class="inp" #rb style="width:140px">@for (b of lk.branches(); track b.id) { <option [value]="b.id">{{ b.name }}</option> }</select>
          <button class="btn sm primary" (click)="add('sales-reps', {name: nr.value, branch_id: +rb.value}); nr.value=''">إضافة</button></div> }
      </div>
    </div>
  </div>
  <div class="actions"><span class="spacer"></span><button class="btn" (click)="tabs.close(tabId())">خروج <span class="k">Esc</span></button></div></div>`,
})
export class StructureForm implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); ui = inject(Ui); auth = inject(Auth); lk = inject(Lookups); tabs = inject(Tabs);
  async ngOnInit() { await this.lk.load(); }
  async add(path: string, body: any) {
    if (!body.name?.trim()) return;
    await this.api.post(`/${path}`, body);
    this.ui.toast('تمت الإضافة', 'ok');
    await this.lk.load();
  }
}
